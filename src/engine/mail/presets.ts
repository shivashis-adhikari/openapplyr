/**
 * Mail providers. App passwords where the provider offers them; OAuth where it is the only
 * way in (Microsoft) or the user brings their own client (Google, advanced).
 */
export type Server = { host: string; port: number; secure: boolean }
export type Preset = {
  id: 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'fastmail' | 'proton' | 'custom'
  label: string
  imap: Server | null
  smtp: Server | null
  auth: 'app_password' | 'oauth' | 'password'
  /** Where to create an app password, shown in the connect dialog. */
  helpUrl: string | null
  /** SMTP does not file sent mail by itself; OpenApplyr appends a copy to Sent over IMAP. */
  appendSent: boolean
  domains: string[]
}

export const PRESETS: Preset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    auth: 'app_password',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    appendSent: false,
    domains: ['gmail.com', 'googlemail.com'],
  },
  {
    id: 'outlook',
    label: 'Outlook or Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    auth: 'oauth',
    helpUrl: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
    appendSent: false,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    auth: 'app_password',
    helpUrl: 'https://login.yahoo.com/account/security/app-passwords',
    appendSent: true,
    domains: ['yahoo.com', 'ymail.com'],
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    auth: 'app_password',
    helpUrl: 'https://support.apple.com/102654',
    appendSent: true,
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    auth: 'app_password',
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
    appendSent: true,
    domains: ['fastmail.com', 'fastmail.fm'],
  },
  {
    id: 'proton',
    label: 'Proton Mail (Bridge)',
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false },
    auth: 'password',
    helpUrl: 'https://proton.me/mail/bridge',
    appendSent: false,
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
  },
  { id: 'custom', label: 'Other (IMAP and SMTP)', imap: null, smtp: null, auth: 'password', helpUrl: null, appendSent: true, domains: [] },
]

export const presetFor = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS.at(-1)!
export const presetForAddress = (address: string): Preset | null => {
  const domain = address.split('@')[1]?.toLowerCase() ?? ''
  return PRESETS.find((p) => p.domains.includes(domain)) ?? null
}
