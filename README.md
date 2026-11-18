# mailcow-mcp

A remote [MCP](https://modelcontextprotocol.io) server that connects AI assistants such as **Claude** to email over plain **IMAP/SMTP**.

Each user adds one URL as a connector, signs in with **their own mailbox email and password**, and can then read, search, send and organise their mail from the assistant. It works with Mailcow, Dovecot/Postfix, cPanel mail, Gmail (app password) and any standard mail server.

```
Claude ──HTTPS──▶ reverse proxy ──▶ mail-mcp :3900 ──IMAP/SMTP──▶ your mail server
                                   │
                                   └─ sign-in page: email + password, checked by an IMAP login
```

## Features

- **Per-user sign-in.** OAuth 2.1 with dynamic client registration and PKCE. The connector opens a sign-in page, and the password is verified by logging in to your IMAP server.
- **Isolated mailboxes.** Every signed-in user sees and sends only from their own mailbox.
- **Encrypted at rest.** Saved sign-ins are AES-256-GCM encrypted. Access tokens are stored only as SHA-256 hashes and expire after 90 days.
- **Brute-force protection.** 5 failed sign-ins per IP address lock that IP out for 10 minutes. You can restrict sign-in to one domain.
- **Mailcow admin tools (optional).** With a Mailcow API key, admins can manage domains, mailboxes, aliases, the mail queue, sync jobs, DKIM, quarantine and logs. Every user also gets self-service tools that are strictly limited to their own mailbox.
- **Safe by default.** Every delete tool needs `confirm: true` and carries the MCP `destructiveHint` annotation. Setting `MAILCOW_API_ACCESS=read-only` hides every write tool.
- **Owner mode (optional).** Fixed accounts (for example a work mailbox and Gmail) can be reached with a static bearer token.
- **Stateless Streamable HTTP transport**, with a Docker image, healthcheck and Compose file included.

## Tools

### Mail (every user, over IMAP/SMTP)

| Tool | What it does |
|---|---|
| `mailbox_summary` | Unread and total message counts per folder |
| `list_folders` | List mail folders |
| `list_emails` | Recent emails in a folder (newest first) |
| `search_emails` | Search by sender, subject, body text or date |
| `read_email` | Full content of one email, with an attachment list |
| `send_email` | Send a new email or a reply (`inReplyTo`), as plain text or HTML |
| `mark_email` | Mark as read/unread, flagged/unflagged |
| `move_email` | Move an email to another folder |
| `delete_email` | Move to Trash, or delete permanently |
| `create_folder` | Create a folder |

### Self-service (every signed-in user; needs `MAILCOW_API_*`)

Each tool only ever sees or changes the caller's own mailbox. Ids belonging to other users are refused.

| Tool | What it does |
|---|---|
| `my_account` | Quota, space used, message count, last login |
| `my_aliases` | Aliases that deliver to me |
| `my_quarantine` / `release_my_quarantine_item` | See spam held for me; release it to the inbox, or delete it |
| `my_app_passwords` / `create_my_app_password` / `delete_my_app_password` | Manage app passwords for phone and desktop mail apps |

### Admin (owner token or `ADMIN_EMAILS`; needs `MAILCOW_API_*`)

| Area | Tools |
|---|---|
| System | `server_status` (version, containers, storage, API check), `get_logs` (postfix, dovecot, rspamd-history, sogo, netfilter, acme, api, ...) |
| Domains | `list_domains`, `get_domain`, `create_domain`, `update_domain`, `delete_domain` |
| Mailboxes | `list_mailboxes`, `get_mailbox`, `create_mailbox`, `update_mailbox`, `delete_mailbox` |
| Aliases | `list_aliases`, `create_alias`, `update_alias`, `delete_alias` |
| Mail queue | `list_mail_queue`, `manage_mail_queue` (flush / deliver / hold / release), `delete_queue_items` |
| Sync jobs | `list_sync_jobs`, `create_sync_job`, `update_sync_job`, `delete_sync_job` |
| DKIM | `get_dkim`, `create_dkim` (both return the DNS record to publish) |
| Quarantine | `list_quarantine`, `delete_quarantine_item` |

In read-only mode only the list/get tools are shown.

### Mailcow API key

In Mailcow, go to **System → Configuration → Access → API**. Create a **read-write** key, or a **read-only** key together with `MAILCOW_API_ACCESS=read-only`, and add this server's IP address to the allowed IPs. Then set:

```env
MAILCOW_API_URL=https://mail.example.com
MAILCOW_API_KEY=your-key
ADMIN_EMAILS=admin@example.com
```

> The API key has full control of your mail server. The self-service tools enforce ownership in this server's code before any API call is made. Give admin rights only to people you trust, and keep `.env` private.

## Quick start (Docker)

```bash
git clone https://github.com/<you>/mailcow-mcp.git
cd mailcow-mcp
cp .env.example .env
# edit .env: PUBLIC_BASE_URL, SESSION_SECRET (openssl rand -hex 32), USER_IMAP_HOST, ...
docker compose up -d --build
curl http://127.0.0.1:3900/healthz   # -> ok
```

### Reverse proxy (HTTPS is required)

MCP clients only connect over HTTPS. Here is an example for **Caddy**, which gets the certificate automatically:

```caddyfile
mcp.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3900
}
```

For **Nginx**, proxy `https://mcp.example.com` to `http://127.0.0.1:3900` and pass `X-Forwarded-For`. Set `PUBLIC_BASE_URL=https://mcp.example.com`.

### Without Docker

```bash
npm install
cp .env.example .env   # and edit it
SESSION_FILE=./data/sessions.json npm start
```

Requires Node.js 20 or newer.

## Connect it to Claude

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Enter your server URL, e.g. `https://mcp.example.com`.
3. Click **Connect**. The sign-in page opens.
4. Enter your mailbox email and password.
5. Ask Claude something like *"show my unread emails from today"*.

## Configuration

All settings are environment variables, usually set in `.env`. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Description |
|---|---|---|
| `PUBLIC_BASE_URL` | yes | Public HTTPS URL of this server |
| `SESSION_SECRET` | yes | 32+ random characters; encrypts saved sign-ins |
| `USER_IMAP_HOST` | for sign-in | IMAP server used to check passwords and read mail |
| `USER_SMTP_HOST` | for sign-in | SMTP server for sending (defaults to the IMAP host) |
| `USER_IMAP_PORT` / `USER_SMTP_PORT` | | Default `993` / `465` |
| `USER_MAIL_DOMAIN` | | Allow only `@this-domain` addresses to sign in (empty = any) |
| `BRAND_NAME` | | Name shown on the sign-in page |
| `OWNER_ACCOUNTS` | | Comma list of fixed accounts, e.g. `work,personal` |
| `MCP_AUTH_TOKEN` | with owner accounts | Static bearer token for the owner accounts |
| `<NAME>_IMAP_HOST`, `<NAME>_EMAIL_ADDRESS`, `<NAME>_EMAIL_PASSWORD`, ... | | Settings for each owner account |
| `MAILCOW_API_URL` / `MAILCOW_API_KEY` | | Turn on the Mailcow admin and self-service tools |
| `MAILCOW_API_ACCESS` | | `read-write` (default) or `read-only` |
| `ADMIN_EMAILS` | | Comma list of signed-in users who get the admin tools |
| `TRUST_PROXY_HOPS` | | Number of reverse proxies in front of the server (default `1`) |

## Security notes

- **Passwords are stored by necessity.** IMAP and SMTP need the password on every connection, so the server keeps it encrypted with `SESSION_SECRET`. Protect `.env` and `data/`. Anyone with both can decrypt the saved passwords.
- **Signing everyone out.** Change `SESSION_SECRET`, or delete `data/sessions.json`, then restart.
- **Expiry.** A sign-in expires after 90 days, and the user then signs in again.
- **Only run it behind HTTPS.** The sign-in page sends the password to this server.
- **Logs.** The request log records only the method, path and status code. Tokens and headers are never logged.
- **Gmail.** Gmail requires an [App Password](https://support.google.com/accounts/answer/185833) when 2-step verification is on.

## Development

```
index.js     MCP server, mail tools, HTTP transport, auth routing
oauth.js     OAuth endpoints, sign-in page, encrypted session store
mailcow.js   Mailcow API client, admin and self-service tools
```

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
