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
const logger = require('./logger');
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

// Fetch all mail folders for a mailbox
async function fetchMailFolders(accessToken, mailbox) {
  const baseUrl = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders?$top=999&$expand=childFolders`;

  const allFolders = [];

  async function fetchPage(url) {
    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error("Graph fetchMailFolders error: " + t);
      }

      const data = await resp.json();

      for (const folder of data.value || []) {
        allFolders.push(folder);

        // RECURSE into child folders if they exist
        if (folder.childFolders && folder.childFolders.length > 0) {
          await fetchChildFolders(folder.id);
        }
      }

      // Pagination link
      url = data["@odata.nextLink"];
    }
  }

  async function fetchChildFolders(folderId) {
    let url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/${folderId}/childFolders?$top=999&$expand=childFolders`;

    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error("Graph fetchChildFolders error: " + t);
      }

      const data = await resp.json();

      for (const child of data.value || []) {
        allFolders.push(child);

        // If this child has more children → recurse again
        if (child.childFolders && child.childFolders.length > 0) {
          await fetchChildFolders(child.id);
        }
      }

      url = data["@odata.nextLink"];
    }
  }

  // Start at root-level folders
  await fetchPage(baseUrl);

  return allFolders;
}


// Fetch unread emails from a specific folder (defaults to Inbox)
async function fetchUnreadEmails(accessToken, mailbox, folderId = 'Inbox') {
  // If folderId is a well-known folder name, use it directly; otherwise use the ID
  const folderPath = folderId.includes('/') ? folderId : `mailFolders/${encodeURIComponent(folderId)}`;
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/${folderPath}/messages?$filter=isRead eq false&$top=10`;

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
    logger.error("Graph markMessageAsRead error:", t);
  }
}


async function sendMailOffice365({ to, subject, htmlBody, textBody }) {
  const token = await getGraphAccessToken();
  const sender = process.env.EMAIL_FROM;
  if (!sender) throw new Error('EMAIL_FROM env var not set');

  const graphUrl = `${GRAPH_BASE}/users/${encodeURIComponent(sender)}/sendMail`;
  const message = {
    message: {
      subject: subject || '',
      body: {
        contentType: 'HTML',
        content: htmlBody || textBody || ''
      },
      toRecipients: [
        { emailAddress: { address: to } }
      ]
    }
  };

  const res = await fetch(graphUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Graph sendMail error ${res.status}: ${txt}`);
  }

  return { ok: true };
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
  fetchMailFolders,
  fetchUnreadEmails,
  markMessageAsRead,
  convertGraphMessage,
  sendMailOffice365
};
