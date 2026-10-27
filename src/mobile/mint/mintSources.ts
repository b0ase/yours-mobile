import type { MintKind } from './mintKinds';

/**
 * "Mint what you already post" (owner, 22 Oct 2026): a row of platforms on the mint-by-type step. Tapping one
 * shows how to get the file of your own post out of that platform, then picks the matching type. Nothing is
 * fetched from the platform; the person downloads their file and picks it as usual.
 */
export type MintSourceId =
  | 'youtube'
  | 'x'
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'linkedin'
  | 'soundcloud'
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'reddit'
  | 'pinterest'
  | 'snapchat'
  | 'threads'
  | 'bluesky'
  | 'mastodon'
  | 'tumblr'
  | 'twitch'
  | 'vimeo'
  | 'bandcamp'
  | 'substack'
  | 'medium'
  | 'github'
  | 'spotify'
  | 'takeout'
  | 'icloud'
  | 'flickr';

/**
 * 'archive' = an export or data package with no dedicated mint type: the tile opens the Books & documents mint
 * (PDF, ebook or text), the closest existing upload. Nothing is read or uploaded from the platform itself.
 */
export type MintSourceKind = MintKind | 'archive';

export type MintSource = { id: MintSourceId; label: string; kind: MintSourceKind; steps: string[]; popular?: boolean };

export const MINT_SOURCES: MintSource[] = [
  {
    id: 'youtube',
    popular: true,
    label: 'YouTube',
    kind: 'video',
    steps: ['In YouTube Studio, open Content, then ⋮ › Download on your video.'],
  },
  {
    id: 'x',
    popular: true,
    label: 'X',
    kind: 'picture',
    steps: [
      'Save the image straight from your post.',
      'For everything: Settings › Your account › Download an archive of your data. Your photos and videos are in it.',
    ],
  },
  {
    id: 'instagram',
    popular: true,
    label: 'Instagram',
    kind: 'picture',
    steps: [
      'Settings › Accounts Center › Your information and permissions › Download your information. Your photos and videos are in it.',
    ],
  },
  {
    id: 'tiktok',
    popular: true,
    label: 'TikTok',
    kind: 'video',
    steps: ['Open your video, tap Share › Save video.'],
  },
  {
    id: 'facebook',
    popular: true,
    label: 'Facebook',
    kind: 'picture',
    steps: [
      'Open your photo, then ⋯ › Download.',
      'For everything: Settings › Accounts Center › Download your information.',
    ],
  },
  {
    id: 'linkedin',
    popular: true,
    label: 'LinkedIn',
    kind: 'picture',
    steps: [
      'Save the image straight from your post.',
      'For everything: Settings › Data privacy › Get a copy of your data.',
    ],
  },
  {
    id: 'soundcloud',
    popular: true,
    label: 'SoundCloud',
    kind: 'music',
    steps: ['Your original upload: on your track, open ⋯ › Edit › Advanced and turn on downloads, then Download file.'],
  },
  {
    id: 'whatsapp',
    popular: true,
    label: 'WhatsApp',
    kind: 'archive',
    steps: ['Open the chat, tap its name › Export chat › Without media, then pick the .txt file.'],
  },
  {
    id: 'telegram',
    label: 'Telegram',
    kind: 'archive',
    steps: ['In Telegram Desktop: Settings › Advanced › Export Telegram data. Pick a text file from the export.'],
  },
  {
    id: 'discord',
    label: 'Discord',
    kind: 'archive',
    steps: ['User Settings › Privacy & Safety › Request all of my Data. Pick a file from the package when it arrives.'],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    kind: 'archive',
    steps: ['Request a copy of your data from your Reddit account settings.'],
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    kind: 'picture',
    steps: ["Export your data from your Pinterest settings, or save a pin's image directly."],
  },
  {
    id: 'snapchat',
    label: 'Snapchat',
    kind: 'picture',
    steps: ['Settings › My Data, then pick a photo or video from the download.'],
  },
  {
    id: 'threads',
    label: 'Threads',
    kind: 'archive',
    steps: ['Export your data from your Threads or Instagram account settings.'],
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    kind: 'archive',
    steps: ['Export your data from your Bluesky account settings.'],
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    kind: 'archive',
    steps: ['Preferences › Import and export › Data export.'],
  },
  {
    id: 'tumblr',
    label: 'Tumblr',
    kind: 'archive',
    steps: ['Export your blog from your Tumblr blog settings.'],
  },
  {
    id: 'twitch',
    label: 'Twitch',
    kind: 'video',
    steps: ['Download your VODs and clips from your Creator Dashboard.'],
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    kind: 'video',
    steps: ["Download your original from your video's page on Vimeo."],
  },
  {
    id: 'bandcamp',
    label: 'Bandcamp',
    kind: 'music',
    steps: ['Use your original audio files; your purchases are downloadable from your collection.'],
  },
  {
    id: 'substack',
    label: 'Substack',
    kind: 'archive',
    steps: ['Dashboard › Settings › Exports. Pick a text or PDF file from it.'],
  },
  {
    id: 'medium',
    label: 'Medium',
    kind: 'archive',
    steps: ['Settings › Account › Download your information.'],
  },
  {
    id: 'github',
    label: 'GitHub',
    kind: 'archive',
    steps: ['Export your account data from your GitHub settings, or save a README as text.'],
  },
  {
    id: 'spotify',
    label: 'Spotify',
    kind: 'archive',
    steps: ['Account › Privacy settings › Download your data (playlists and history).'],
  },
  {
    id: 'takeout',
    label: 'Google Takeout',
    kind: 'picture',
    steps: ['Go to takeout.google.com and export Google Photos or YouTube. Pick a photo or video from it.'],
  },
  {
    id: 'icloud',
    label: 'iCloud Photos',
    kind: 'picture',
    steps: ['In Photos, select your pictures and choose File › Export.'],
  },
  {
    id: 'flickr',
    label: 'Flickr',
    kind: 'picture',
    steps: ['Request your Flickr data from your account settings, or save a photo directly.'],
  },
];

export const mintSource = (id: MintSourceId) => MINT_SOURCES.find((s) => s.id === id);
