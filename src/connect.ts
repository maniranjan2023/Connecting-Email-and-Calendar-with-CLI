import { Composio } from "@composio/core";

const composio = new Composio();

const gmailAuthConfigId = process.env.GMAIL_AUTH_CONFIG_ID;
const calendarAuthConfigId = process.env.GOOGLECALENDAR_AUTH_CONFIG_ID;

if (!gmailAuthConfigId || !calendarAuthConfigId) {
  throw new Error(
    "Auth config IDs not set. Run `COMPOSIO_API_KEY=<key> sh scaffold.sh` first."
  );
}

const USER_ID = "candidate";

console.log("Connecting Gmail account...");
const gmailLink = await composio.connectedAccounts.link(
  USER_ID,
  gmailAuthConfigId
);
console.log("Open this URL to connect Gmail:", gmailLink.redirectUrl ?? gmailLink);
const gmailAccount = await gmailLink.waitForConnection();
console.log("Gmail connected.");
console.log(`Add to .env: COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID=${gmailAccount.id}\n`);

console.log("Connecting Google Calendar account...");
const calendarLink = await composio.connectedAccounts.link(
  USER_ID,
  calendarAuthConfigId
);
console.log("Open this URL to connect Calendar:", calendarLink.redirectUrl ?? calendarLink);
const calendarAccount = await calendarLink.waitForConnection();
console.log("Google Calendar connected.");
console.log(
  `Add to .env: COMPOSIO_GOOGLECALENDAR_CONNECTED_ACCOUNT_ID=${calendarAccount.id}\n`
);

console.log(
  "Both accounts connected. `proxyExecute` needs those COMPOSIO_*_CONNECTED_ACCOUNT_ID values (not the user id string)."
);
