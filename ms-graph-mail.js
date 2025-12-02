/*
Helper for Microsoft Graph app-only sendMail using client credentials.
Requires environment variables:
MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, EMAIL_FROM
*/
const fetch = globalThis.fetch;

async function getAccessToken() {
  const tenant = process.env.MS_GRAPH_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET;

  if (!tenant || !clientId || !clientSecret) {
    throw new Error('Missing MS Graph env vars');
  }

  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', 'https://graph.microsoft.com/.default');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token endpoint error ${res.status}: ${txt}`);
  }
  const j = await res.json();
  return j.access_token;
}

async function sendMailOffice365({ to, subject, htmlBody, textBody }) {
  const token = await getAccessToken();
  const sender = process.env.EMAIL_FROM;
  if (!sender) throw new Error('EMAIL_FROM not set');

  const graphUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

  const message = {
    message: {
      subject: subject,
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

module.exports = { sendMailOffice365 };
