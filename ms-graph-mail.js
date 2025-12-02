// ms-graph-mail.js
//
// Handles Microsoft Graph email polling for inbound messages
// Using Client Credentials OAuth2 (Application Permissions)
//
// Requires ENV:
// MS_GRAPH_TENANT_ID
// MS_GRAPH_CLIENT_ID
// MS_GRAPH_CLIENT_SECRET
// EMAIL_FROM (the mailbox to poll)

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function getGraphAccessToken() {
  const tenant = process.env.MS_GRAPH_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const secret = process.env.MS_GRAPH_CLIENT_SECRET;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }
  );

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Graph token error: " + t);
  }

  const json = await resp.json();
  return json.access_token;
}

// Fetch unread emails from inbox
async function fetchUnreadEmails(accessToken, mailbox) {
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?$filter=isRead eq false&$top=10`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Graph fetchUnreadEmails error: " + t);
  }

  const data = await resp.json();
  return data.value || [];
}

// Mark message as read
async function markMessageAsRead(accessToken, mailbox, id) {
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${id}`;

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ isRead: true })
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Graph markMessageAsRead error:", t);
  }
}

// Convert Graph message → webhook email format
function convertGraphMessage(msg) {
  return {
    from: msg.from?.emailAddress?.address || "",
    subject: msg.subject || "",
    text: msg.bodyPreview || "",
    html: msg.body?.content || "",
    attachments: msg.attachments || [],
    raw: msg.body?.content || ""
  };
}

module.exports = {
  getGraphAccessToken,
  fetchUnreadEmails,
  markMessageAsRead,
  convertGraphMessage
};
