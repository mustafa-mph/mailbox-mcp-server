#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

import express from "express";
import crypto from "node:crypto";
import { setupOAuth, createSessionStore } from "./oauth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

// ---- Owner accounts (optional, used with the static MCP_AUTH_TOKEN) ----
// OWNER_ACCOUNTS=work,personal  ->  reads WORK_IMAP_HOST, WORK_EMAIL_ADDRESS, ... and PERSONAL_IMAP_HOST, ...
const ACCOUNT_PREFIXES = Object.fromEntries(
  (process.env.OWNER_ACCOUNTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => [name, name.toUpperCase().replace(/[^A-Z0-9]/g, "_")])
);

function loadAccount(prefix) {
  const get = (k) => process.env[`${prefix}_${k}`];
  const required = ["IMAP_HOST", "SMTP_HOST", "EMAIL_ADDRESS", "EMAIL_PASSWORD"];
  if (required.some((k) => !get(k))) return null;
  return {
    imapHost: get("IMAP_HOST"),
    imapPort: Number(get("IMAP_PORT") || "993"),
    imapSecure: (get("IMAP_SECURE") || "true") === "true",
    smtpHost: get("SMTP_HOST"),
    smtpPort: Number(get("SMTP_PORT") || "465"),
    smtpSecure: (get("SMTP_SECURE") || "true") === "true",
    address: get("EMAIL_ADDRESS"),
    password: get("EMAIL_PASSWORD"),
  };
}

const ACCOUNTS = {};
for (const [name, prefix] of Object.entries(ACCOUNT_PREFIXES)) {
  const acc = loadAccount(prefix);
  if (acc) ACCOUNTS[name] = acc;
}

const accountNames = Object.keys(ACCOUNTS);

// ---- Per-user mailbox sign-in (each client logs in with their own mailbox on your mail server) ----
const USER_IMAP_HOST = process.env.USER_IMAP_HOST || "";
const USER_IMAP_PORT = Number(process.env.USER_IMAP_PORT || "993");
const USER_IMAP_SECURE = (process.env.USER_IMAP_SECURE || "true") === "true";
const USER_SMTP_HOST = process.env.USER_SMTP_HOST || USER_IMAP_HOST;
const USER_SMTP_PORT = Number(process.env.USER_SMTP_PORT || "465");
const USER_SMTP_SECURE = (process.env.USER_SMTP_SECURE || "true") === "true";
const USER_MAIL_DOMAIN = (process.env.USER_MAIL_DOMAIN || "").trim(); // empty = any mailbox on the server may sign in
const BRAND_NAME = process.env.BRAND_NAME || "Mail MCP";

if (!USER_IMAP_HOST && accountNames.length === 0) {
  console.error("Nothing to serve: set USER_IMAP_HOST (per-user sign-in) and/or OWNER_ACCOUNTS. See .env.example.");
  process.exit(1);
}

function userAccount(email, password) {
  return {
    imapHost: USER_IMAP_HOST, imapPort: USER_IMAP_PORT, imapSecure: USER_IMAP_SECURE,
    smtpHost: USER_SMTP_HOST, smtpPort: USER_SMTP_PORT, smtpSecure: USER_SMTP_SECURE,
    address: email, password,
  };
}

// True only when the mail server explicitly rejected the username/password
// (not for network errors or timeouts, which must never sign anyone out).
function isAuthError(err) {
  if (!err) return false;
  if (err.authenticationFailed === true || err.code === "EAUTH") return true;
  return /AUTHENTICATIONFAILED|authentication failed|invalid credentials/i.test(`${err.responseText || ""} ${err.message || ""}`);
}

// "ok" | "auth_failed" | "unavailable"
async function checkLogin(email, password) {
  if (!USER_IMAP_HOST) return "unavailable";
  const client = new ImapFlow({
    host: USER_IMAP_HOST, port: USER_IMAP_PORT, secure: USER_IMAP_SECURE,
    auth: { user: email, pass: password }, logger: false,
  });
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return "ok";
  } catch (err) {
    return isAuthError(err) ? "auth_failed" : "unavailable";
  }
}

const verifyLogin = async (email, password) => (await checkLogin(email, password)) === "ok";

async function withImap(acc, fn) {
  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: { user: acc.address, pass: acc.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

function getTransporter(acc) {
  return nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    auth: { user: acc.address, pass: acc.password },
  });
}

// ---- MCP server ----

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// accounts: { name: accountConfig } visible to this caller. A signed-in user sees only their own mailbox.
// onAuthFailure: called when the mail server rejects a signed-in user's saved password (it was changed).
function buildServer(accounts, { onAuthFailure } = {}) {
  const server = new McpServer({ name: "mailbox-mcp-server", version: "1.3.0" });
  const errorResult = (err) => {
    if (onAuthFailure && isAuthError(err)) {
      onAuthFailure();
      return {
        content: [{ type: "text", text: "Error: The mail server rejected the saved password - it was probably changed. You have been signed out of this connector; reconnect it and sign in with your new password." }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  };
  const names = Object.keys(accounts);
  const accountEnum = z
    .enum(names)
    .optional()
    .describe(names.length > 1 ? `Which account to use (${names.join(", ")}). Defaults to ${names[0]}.` : `Your mailbox (${names[0]}). Optional.`);
  const acc = (name) => {
    const a = accounts[name ?? names[0]];
    if (!a) throw new Error(`Unknown account "${name}". Available: ${names.join(", ")}`);
    return a;
  };

  server.registerTool(
    "list_folders",
    {
      description: "List all mail folders/mailboxes on the given account.",
      inputSchema: { account: accountEnum },
    },
    async ({ account }) => {
      try {
        const folders = await withImap(acc(account),async (client) => {
          const list = await client.list();
          return list.map((f) => ({ name: f.path, specialUse: f.specialUse || null }));
        });
        return textResult(folders);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_emails",
    {
      description: "List recent emails in a folder, newest first. Returns uid, subject, from, date, and unread flag.",
      inputSchema: {
        account: accountEnum,
        folder: z.string().default("INBOX"),
        limit: z.number().default(20),
      },
    },
    async ({ account, folder, limit }) => {
      try {
        const emails = await withImap(acc(account),async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const results = [];
            const total = client.mailbox.exists;
            if (total === 0) return results;
            const start = Math.max(1, total - limit + 1);
            for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
              results.push({
                uid: msg.uid,
                subject: msg.envelope?.subject || "(no subject)",
                from: msg.envelope?.from?.map((a) => a.address).join(", "),
                date: msg.envelope?.date,
                unread: !msg.flags?.has("\\Seen"),
              });
            }
            return results.reverse();
          } finally {
            lock.release();
          }
        });
        return textResult(emails);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_emails",
    {
      description: "Search emails in a folder by sender, subject, body text, or date range.",
      inputSchema: {
        account: accountEnum,
        folder: z.string().default("INBOX"),
        from: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        since: z.string().optional().describe("ISO date; only emails on/after this date"),
        limit: z.number().default(20),
      },
    },
    async ({ account, folder, from, subject, text, since, limit }) => {
      try {
        const criteria = {};
        if (from) criteria.from = from;
        if (subject) criteria.subject = subject;
        if (text) criteria.body = text;
        if (since) criteria.since = new Date(since);

        const emails = await withImap(acc(account),async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const uids = await client.search(criteria, { uid: true });
            const slice = uids.slice(-limit).reverse();
            const results = [];
            for (const uid of slice) {
              const msg = await client.fetchOne(uid, { envelope: true, uid: true });
              if (msg) {
                results.push({
                  uid: msg.uid,
                  subject: msg.envelope?.subject || "(no subject)",
                  from: msg.envelope?.from?.map((a) => a.address).join(", "),
                  date: msg.envelope?.date,
                });
              }
            }
            return results;
          } finally {
            lock.release();
          }
        });
        return textResult(emails);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "read_email",
    {
      description: "Fetch the full content (headers + body) of one email by uid.",
      inputSchema: {
        account: accountEnum,
        folder: z.string().default("INBOX"),
        uid: z.number().describe("The email's UID from list/search results"),
      },
    },
    async ({ account, folder, uid }) => {
      try {
        const email = await withImap(acc(account),async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const { content } = await client.download(uid, undefined, { uid: true });
            const parsed = await simpleParser(content);
            return {
              subject: parsed.subject,
              from: parsed.from?.text,
              to: parsed.to?.text,
              date: parsed.date,
              messageId: parsed.messageId,
              text: parsed.text,
              attachments: (parsed.attachments || []).map((a) => ({
                filename: a.filename,
                size: a.size,
                contentType: a.contentType,
              })),
            };
          } finally {
            lock.release();
          }
        });
        return textResult(email);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "send_email",
    {
      description: "Compose and send a new email, or reply to an existing thread.",
      inputSchema: {
        account: accountEnum,
        to: z.string().describe("Comma-separated recipient addresses"),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string(),
        text: z.string().describe("Plain text body"),
        html: z.string().optional(),
        inReplyTo: z.string().optional().describe("Message-Id being replied to, if any"),
      },
    },
    async ({ account, to, cc, bcc, subject, text, html, inReplyTo }) => {
      try {
        const a = acc(account);
        const transporter = getTransporter(a);
        const info = await transporter.sendMail({
          from: a.address,
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          inReplyTo,
          references: inReplyTo,
        });
        return textResult({ sent: true, messageId: info.messageId });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "move_email",
    {
      description: "Move an email from one folder to another.",
      inputSchema: {
        account: accountEnum,
        folder: z.string().default("INBOX"),
        uid: z.number(),
        destination: z.string().describe("Target folder name, e.g. Archive"),
      },
    },
    async ({ account, folder, uid, destination }) => {
      try {
        await withImap(acc(account),async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            await client.messageMove(uid, destination, { uid: true });
          } finally {
            lock.release();
          }
        });
        return textResult({ moved: true, uid, to: destination });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "delete_email",
    {
      description: "Delete an email. By default moves it to Trash; set permanent=true to expunge immediately.",
      inputSchema: {
        account: accountEnum,
        folder: z.string().default("INBOX"),
        uid: z.number(),
        permanent: z.boolean().default(false),
      },
    },
    async ({ account, folder, uid, permanent }) => {
      try {
        await withImap(acc(account),async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            if (permanent) {
              await client.messageDelete(uid, { uid: true });
            } else {
              await client.messageMove(uid, "Trash", { uid: true });
            }
          } finally {
            lock.release();
          }
        });
        return textResult({ deleted: true, uid, permanent: !!permanent });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_folder",
    {
      description: "Create a new mail folder.",
      inputSchema: { account: accountEnum, name: z.string() },
    },
    async ({ account, name }) => {
      try {
        await withImap(acc(account),async (client) => {
          await client.mailboxCreate(name);
        });
        return textResult({ created: true, name });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "mark_email",
    {
      description: "Mark emails as read/unread or flagged/unflagged.",
      inputSchema: {
        account: accountEnum,
        folder: z.string().default("INBOX"),
        uids: z.array(z.number()).min(1),
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ account, folder, uids, read, flagged }) => {
      try {
        if (read === undefined && flagged === undefined) throw new Error("Set read and/or flagged.");
        await withImap(acc(account), async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            if (read === true) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
            if (read === false) await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
            if (flagged === true) await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
            if (flagged === false) await client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
          } finally {
            lock.release();
          }
        });
        return textResult({ updated: uids.length, read, flagged });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "mailbox_summary",
    {
      description: "Unread and total message counts for every folder - a quick overview of the mailbox.",
      inputSchema: { account: accountEnum },
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      try {
        const rows = await withImap(acc(account), async (client) => {
          const out = [];
          for (const f of await client.list()) {
            if (f.flags?.has("\\Noselect")) continue;
            const s = await client.status(f.path, { messages: true, unseen: true }).catch(() => null);
            if (s) out.push({ folder: f.path, messages: s.messages, unread: s.unseen });
          }
          return out;
        });
        return textResult(rows);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

// ---- HTTP transport (stateless) with bearer-token auth ----
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; // optional: static token for the owner accounts
const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be set to a random string of at least 32 characters (e.g. `openssl rand -hex 32`).");
  process.exit(1);
}
if (accountNames.length && AUTH_TOKEN.length < 32) {
  console.error("OWNER_ACCOUNTS is set, so MCP_AUTH_TOKEN must be a random string of at least 32 characters.");
  process.exit(1);
}
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(PUBLIC_BASE_URL)) {
  console.error("PUBLIC_BASE_URL must be set to the public URL of this server, e.g. https://mcp.example.com");
  process.exit(1);
}

const sessions = createSessionStore({
  file: process.env.SESSION_FILE || "/data/sessions.json",
  secret: SESSION_SECRET,
});

const app = express();
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || "1")); // behind a reverse proxy: real client IP for rate limiting
app.use(express.json({ limit: "10mb" }));

// request log: method, path and status only (never headers or tokens)
app.use((req, res, next) => {
  res.on("finish", () => { if (req.path !== "/healthz") console.error(`${req.method} ${req.originalUrl.split("?")[0]} -> ${res.statusCode}`); });
  next();
});

// OAuth (dynamic client registration + PKCE): MCP clients such as Claude open a mailbox sign-in page
setupOAuth(app, { baseUrl: PUBLIC_BASE_URL, verifyLogin, sessions, mailDomain: USER_MAIL_DOMAIN, brandName: BRAND_NAME });

const sameSecret = (a, b) =>
  crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());

// Bearer token -> { accounts, session } for this caller (null = not signed in)
function callerForToken(token) {
  if (!token) return null;
  if (AUTH_TOKEN && accountNames.length && sameSecret(token, AUTH_TOKEN)) return { accounts: ACCOUNTS, session: null }; // owner accounts
  const s = sessions.get(token);
  if (!s) return null;
  return { accounts: { [s.email]: userAccount(s.email, s.password) }, session: s };
}

const isInitialize = (body) => (Array.isArray(body) ? body : [body]).some((m) => m && m.method === "initialize");

// the MCP endpoint also answers at the bare domain, not only at /mcp
app.use((req, _res, next) => { if (req.path === "/") req.url = "/mcp" + req.url.slice(1); next(); });

app.post("/mcp", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const unauthorized = () => {
    // tells MCP clients where to find the OAuth details, so they show the sign-in page again
    res.set("WWW-Authenticate", `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource${req.originalUrl.startsWith("/mcp") ? "/mcp" : ""}"`);
    res.status(401).json({ error: "Unauthorized" });
  };
  const caller = callerForToken(token);
  if (!caller) return unauthorized();

  // When a client (re)connects, re-check the saved password. If the mail server now rejects it,
  // drop the sign-in and answer 401 so the client asks the user to sign in again.
  if (caller.session && isInitialize(req.body)) {
    const result = await checkLogin(caller.session.email, caller.session.password);
    if (result === "auth_failed") {
      sessions.revoke(token);
      console.error(`saved password rejected for ${caller.session.email}: signed out`);
      return unauthorized();
    }
  }

  try {
    const onAuthFailure = caller.session
      ? () => { sessions.revoke(token); console.error(`saved password rejected for ${caller.session.email}: signed out`); }
      : undefined;
    const server = buildServer(caller.accounts, { onAuthFailure });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server, use POST)" });
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

const PORT = Number(process.env.PORT || "3900");
app.listen(PORT, () => {
  console.error(
    `mailbox-mcp-server listening on :${PORT} | public URL ${PUBLIC_BASE_URL} | user sign-in: ${USER_IMAP_HOST || "off"}` +
      ` (domain: ${USER_MAIL_DOMAIN || "any"}, saved sign-ins: ${sessions.count()}) | owner accounts: ${accountNames.join(", ") || "none"}`
  );
});
