# Mailchimp

This connector uses the official Mailchimp Marketing API v3.0. It works with your own account's API key; you do not need to register an OAuth app.

## Connect your account

1. Sign in to [Mailchimp](https://login.mailchimp.com/).
2. Open your profile menu, choose **Account & billing**, then **Extras → API keys**. Mailchimp also provides [API key instructions](https://mailchimp.com/help/about-api-keys/). If this menu is unavailable, ask your account owner for API access.
3. Click **Create A Key**, name it **Connector**, and generate it.
4. Copy the complete key when Mailchimp displays it, including its data center suffix such as `-us21`. Mailchimp only displays a newly generated key once.
5. In Connector, open **Connections**, find **Mailchimp**, and click **Connect**.
6. Paste the key into the API key field and submit. The connected account name appears after verification. Connector stores the key encrypted with your other connections.

Use a Marketing API key, not a Mailchimp Transactional/Mandrill key. The API key has the permissions of the Mailchimp user who created it. Sender verification, account permissions, pricing, and sending limits continue to apply.

## Use it from your AI agent

Once the agent can use Connector's existing MCP connection, it discovers Mailchimp's actions automatically. Ask it to:

1. **List audiences** and identify the audience you want. Results include audience IDs and subscribed-contact counts; they do not expose subscribers' email addresses.
2. **Create email campaign draft**, specifying the audience ID, internal title, subject, sender name, and reply-to email on a sender domain verified in Mailchimp. This creates a regular campaign draft for all subscribed contacts in that audience. It does not send email.
3. **Set draft email content** using the returned campaign ID and your HTML. Include Mailchimp's unsubscribe link (`*|UNSUB|*`) and required mailing-address footer (for example `*|HTML:LIST_ADDRESS_HTML|*`). Content is limited to 50,000 characters per action.
4. Review the draft in Mailchimp, including its content, audience, and eligible recipients. You can also ask the agent to **Read campaign** for its current subject, status, sender, audience, and recipient count.
5. Explicitly ask it to **Send email campaign now**, identifying both the campaign and its audience. This is a separate write action that requires confirmation and a unique request ID through Connector. Mailchimp validates the campaign and sends it immediately. The response confirms acceptance, not delivery.
6. **Read campaign report** to retrieve aggregate sent, open, click, bounce, unsubscribe, and abuse-report metrics. Reports can take time to appear. Mailchimp tracking and email privacy features affect open/click measurements.

**List email campaigns** retrieves existing regular campaigns, including drafts. List actions return one page at a time, with a `nextOffset` when more results exist. Default page size is 50, with a maximum of 100.

Only regular draft campaigns can be edited or sent through this connector. Subscriber imports, audience membership changes, transactional email, campaign deletion, and campaign scheduling are not exposed in this version. Existing segments configured in Mailchimp remain part of a campaign's recipient selection; review recipients there before sending.

If a send request times out or fails ambiguously, check Mailchimp before making another submission. Reusing the same successful Connector request ID returns the existing receipt without sending again. An uncertain receipt prevents an automatic retry.

## Official API references

- [Mailchimp API fundamentals and authentication](https://mailchimp.com/developer/marketing/docs/fundamentals/)
- [Account verification](https://mailchimp.com/developer/marketing/api/root/)
- [Audiences](https://mailchimp.com/developer/marketing/api/lists/)
- [Create campaign](https://mailchimp.com/developer/marketing/api/campaigns/add-campaign/)
- [Set campaign content](https://mailchimp.com/developer/marketing/api/campaign-content/set-campaign-content/)
- [Send campaign](https://mailchimp.com/developer/marketing/api/campaigns/send-campaign/)
- [Campaign reports](https://mailchimp.com/developer/marketing/api/reports/get-campaign-report/)
- [Mailchimp's official Node SDK endpoint definitions](https://github.com/mailchimp/mailchimp-marketing-node)

API destinations are derived only from a validated Mailchimp data center suffix and always use HTTPS on `usNN.api.mailchimp.com`. Responses expose selected account and campaign fields; upstream errors and authorization headers are not returned to your agent.
