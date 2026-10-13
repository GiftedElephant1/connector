# WhatsApp Business

Connector uses the official WhatsApp Business Cloud API. Connect a business phone number from the dashboard using its **access token** and **phone number ID**. No terminal commands or `.env` changes are needed for this connection.

This does not sign into a personal WhatsApp account or scan a WhatsApp Web QR code. Meta's Embedded Signup is a separate integration requiring a configured and approved Meta application; this release uses a guided credential connection.

## Connect from the dashboard

1. Open [Meta for Developers → My Apps](https://developers.facebook.com/apps/) and sign into the Meta account that owns your business.
2. Create or open a business application with the **WhatsApp** product/use case. Follow Meta's business onboarding if prompted.
3. In the app's WhatsApp product, open **API Setup** (some dashboard versions call the initial page **Getting Started**).
4. Select the sending business phone number. For an initial test, Meta provides a test number; add and verify your own recipient number in the test recipient list.
5. Find **Phone number ID**, use its copy button, and keep the value available. This is a numeric Meta object ID, not the phone number beginning with `+`.
6. Find **Temporary access token** and use its copy button. Complete any Meta authorization prompt. Temporary tokens expire; they are suitable for an initial connection test.
7. Open Connector → **Connections** → **WhatsApp Business** → **Connect account**.
8. Paste the Meta access token into the API key/access-token field. Paste the copied **Phone number ID** into its matching field.
9. Save/connect. Connector reads the phone number's verified business name and display number from Meta and displays the verified connection.

For ongoing use, create a system user under your Meta business settings, assign the application and WhatsApp Business Account assets, and generate an access token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions and access to the sending number. Replace the temporary credential in Connector when ready. Production use can require business verification, app review, a registered phone number, and billing setup. Meta controls which permissions and assets your token can access.

The WhatsApp Business Account ID (**WABA ID**) is also displayed in API Setup. Keep it for the **List message templates** action. It is different from both the phone number and phone number ID.

## Actions

| Action | Requirement |
|---|---|
| Read business phone number | Access to the connected phone number |
| Read business profile | Business profile permission for the phone |
| List message templates | WABA ID and management access; returns up to 100 templates |
| Send service-window message | An opted-in recipient who messaged the business within the last 24 hours |
| Reply to a WhatsApp message | Same open service window plus the original `wamid...` message ID |
| Send approved template | Exact approved template name/language and recipient opt-in; can be scheduled |

Free-text sends and replies are immediate only, because the 24-hour customer service window may expire before a scheduled send. The action requires an explicit statement that the window is open; Connector cannot independently determine it and Meta enforces the restriction. Use approved templates outside that window. Scheduled templates still must be approved and the credential valid at execution time. Meta messaging charges may apply.

All sends are write actions. The existing pipeline requires explicit confirmation and a unique request ID before execution. An API acceptance/message ID is not proof of delivery.

## Text template example

For Meta's initial `hello_world` test template, choose language `en_US` and leave components blank. Test numbers can only message the recipients verified in Meta's test setup.

For an approved template containing one body variable, use:

```json
[
  {
    "type": "body",
    "parameters": [{ "type": "text", "text": "Alex" }]
  }
]
```

This release supports positional text parameters in at most one body and one text header component. It does not support media, buttons, named variables, currency, or date/time parameters. Meta validates the template's approved content, language, and parameter count.

## Incoming messages and scope

There is no WhatsApp conversation-history read endpoint in this connector. This release does not configure an incoming-message webhook, fetch an inbox, or receive delivery receipts. A reply's original message ID must come from a separately configured official webhook integration. Do not assume that connecting the phone makes incoming messages visible to Grok.

Credentials are saved in Connector's encrypted credential store. Requests use bearer headers to `https://graph.facebook.com/v26.0`; the token is never put in a query URL. Connection checks are read-only and do not send test messages.

## Official references

- [Cloud API getting started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
- [Messages reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)
- [Business profiles](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles)
- [Message templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates)
- [Meta's Node SDK request builder](https://github.com/WhatsApp/WhatsApp-Nodejs-SDK/blob/main/src/api/messages.ts) (reference for `messaging_product`, template payloads, and `context.message_id`; Connector calls the API directly)
