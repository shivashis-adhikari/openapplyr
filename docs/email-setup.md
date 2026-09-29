# Connecting email

OpenApplyr reads job-related mail over IMAP and sends the notes you approve over SMTP, from your own account.

## Gmail, Yahoo, iCloud, Fastmail

These use an app password: a separate password the provider generates for one app, which you can revoke at any time. Settings, Email links to the page where each provider creates one. Gmail needs 2-Step Verification turned on before it offers app passwords.

## Proton Mail

Proton Mail works through [Proton Mail Bridge](https://proton.me/mail/bridge), which runs on your computer and exposes IMAP and SMTP. Use the address and password Bridge shows.

## Outlook and Microsoft 365

Microsoft no longer accepts passwords for IMAP, so OpenApplyr signs in with Microsoft. Microsoft requires each installation to use its own app registration, which is free:

1. Go to the [Microsoft Entra admin center](https://entra.microsoft.com), then **App registrations**, then **New registration**. A personal Microsoft account can do this.
2. Name it anything, for example `OpenApplyr on my laptop`.
3. Under **Supported account types**, choose the option that includes personal Microsoft accounts if you use Outlook.com, Hotmail or Live; otherwise your organization only.
4. Under **Redirect URI**, choose **Public client/native (mobile & desktop)** and enter `http://127.0.0.1`.
5. Select **Register**, then copy the **Application (client) ID** from the overview page.
6. In OpenApplyr, choose Outlook or Microsoft 365, paste the ID, and select **Sign in with Microsoft**.

OpenApplyr asks for permission to read mail over IMAP, send over SMTP, and stay signed in. Some work and school accounts block IMAP or app registrations; your administrator can allow them.

## Any other provider

Choose **Other** and enter the IMAP and SMTP servers from your provider's help pages.
