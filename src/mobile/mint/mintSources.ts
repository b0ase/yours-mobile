import type { MintKind } from './mintKinds';

/**
 * "Mint what you already post" (owner, 22 Oct 2026; Mint sheet v2, 1 Nov 2026): the apps on the Mint sheet. Tapping
 * one opens its card: what its data download holds, how to get your own file out, and Upload your archive. Nothing
 * is fetched from the platform; the person downloads their file and picks it as usual. 27 apps; 18 of them could be
 * linked by signing in (Link an account, not open yet), the rest offer a download only.
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

export type MintSource = {
  id: MintSourceId;
  label: string;
  /** Which existing mint a single file from this platform opens (the Mint sheet's "Pick a file"). */
  kind: MintSourceKind;
  /** How to get your own file out of the platform. */
  steps: string[];
  /** In the first row of the Mint sheet (the rest are under More apps). */
  popular?: boolean;
  /** One line: what people keep there. */
  what: string;
  /**
   * Whether the platform lets you sign in and share your posts with another app (the Link an account card, not
   * open yet). False = download only (Upload your archive).
   */
  link: boolean;
  /** What the platform's own data download contains. */
  get: string[];
};

export const MINT_SOURCES: MintSource[] = [
  {
    id: 'instagram',
    popular: true,
    what: 'Photos, reels, captions',
    link: true,
    get: [
      'Photos and reels',
      'Captions and comments',
      'Stories you saved',
      'Followers and following',
      'Messages (optional)',
    ],
    label: 'Instagram',
    kind: 'picture',
    steps: [
      'Settings › Accounts Center › Your information and permissions › Download your information. Your photos and videos are in it.',
    ],
  },
  {
    id: 'tiktok',
    popular: true,
    what: 'Videos and captions',
    link: true,
    get: ['Your videos', 'Captions and sounds', 'Comments and likes', 'Followers'],
    label: 'TikTok',
    kind: 'video',
    steps: ['Open your video, tap Share › Save video.'],
  },
  {
    id: 'facebook',
    popular: true,
    what: 'Posts, photos, life events',
    link: true,
    get: [
      'Posts and photos',
      'Albums and life events',
      'Comments and reactions',
      'Friends list',
      'Messages (optional)',
    ],
    label: 'Facebook',
    kind: 'picture',
    steps: [
      'Open your photo, then ⋯ › Download.',
      'For everything: Settings › Accounts Center › Download your information.',
    ],
  },
  {
    id: 'youtube',
    popular: true,
    what: 'Videos and descriptions',
    link: true,
    get: ['Your videos at full quality', 'Titles, descriptions, captions', 'Playlists and comments'],
    label: 'YouTube',
    kind: 'video',
    steps: ['In YouTube Studio, open Content, then ⋮ › Download on your video.'],
  },
  {
    id: 'x',
    popular: true,
    what: 'Posts, replies, media',
    link: true,
    get: ['Every post and reply', 'Photos and videos', 'Likes and bookmarks', 'Followers'],
    label: 'X',
    kind: 'picture',
    steps: [
      'Save the image straight from your post.',
      'For everything: Settings › Your account › Download an archive of your data. Your photos and videos are in it.',
    ],
  },
  {
    id: 'linkedin',
    popular: true,
    what: 'Work history, posts',
    link: true,
    get: ['Profile and work history', 'Posts and articles', 'Connections', 'Recommendations'],
    label: 'LinkedIn',
    kind: 'picture',
    steps: [
      'Save the image straight from your post.',
      'For everything: Settings › Data privacy › Get a copy of your data.',
    ],
  },
  {
    id: 'whatsapp',
    popular: true,
    what: 'Chats with family and friends',
    link: false,
    get: ['A chat’s messages', 'Photos and voice notes in it'],
    label: 'WhatsApp',
    kind: 'archive',
    steps: ['Open the chat, tap its name › Export chat › Without media, then pick the .txt file.'],
  },
  {
    id: 'soundcloud',
    what: 'Your original tracks',
    link: true,
    get: ['Original uploads', 'Track descriptions'],
    label: 'SoundCloud',
    kind: 'music',
    steps: ['Your original upload: on your track, open ⋯ › Edit › Advanced and turn on downloads, then Download file.'],
  },
  {
    id: 'telegram',
    what: 'Chats and channels',
    link: false,
    get: ['Chats', 'Channel posts', 'Media'],
    label: 'Telegram',
    kind: 'archive',
    steps: ['In Telegram Desktop: Settings › Advanced › Export Telegram data. Pick a text file from the export.'],
  },
  {
    id: 'discord',
    what: 'Your messages',
    link: false,
    get: ['Messages you sent', 'Servers'],
    label: 'Discord',
    kind: 'archive',
    steps: ['User Settings › Privacy & Safety › Request all of my Data. Pick a file from the package when it arrives.'],
  },
  {
    id: 'reddit',
    what: 'Posts and comments',
    link: true,
    get: ['Posts', 'Comments', 'Saved items'],
    label: 'Reddit',
    kind: 'archive',
    steps: ['Request a copy of your data from your Reddit account settings.'],
  },
  {
    id: 'pinterest',
    what: 'Boards and pins',
    link: true,
    get: ['Pins and boards'],
    label: 'Pinterest',
    kind: 'picture',
    steps: ["Export your data from your Pinterest settings, or save a pin's image directly."],
  },
  {
    id: 'snapchat',
    what: 'Memories and chats',
    link: false,
    get: ['Memories', 'Chat history'],
    label: 'Snapchat',
    kind: 'picture',
    steps: ['Settings › My Data, then pick a photo or video from the download.'],
  },
  {
    id: 'threads',
    what: 'Posts and replies',
    link: true,
    get: ['Posts', 'Replies'],
    label: 'Threads',
    kind: 'archive',
    steps: ['Export your data from your Threads or Instagram account settings.'],
  },
  {
    id: 'bluesky',
    what: 'Posts',
    link: true,
    get: ['Posts and replies', 'Media'],
    label: 'Bluesky',
    kind: 'archive',
    steps: ['Export your data from your Bluesky account settings.'],
  },
  {
    id: 'mastodon',
    what: 'Posts',
    link: true,
    get: ['Posts', 'Media', 'Follows'],
    label: 'Mastodon',
    kind: 'archive',
    steps: ['Preferences › Import and export › Data export.'],
  },
  {
    id: 'tumblr',
    what: 'Posts',
    link: true,
    get: ['Posts', 'Media'],
    label: 'Tumblr',
    kind: 'archive',
    steps: ['Export your blog from your Tumblr blog settings.'],
  },
  {
    id: 'twitch',
    what: 'VODs and clips',
    link: true,
    get: ['Past broadcasts', 'Clips'],
    label: 'Twitch',
    kind: 'video',
    steps: ['Download your VODs and clips from your Creator Dashboard.'],
  },
  {
    id: 'vimeo',
    what: 'Videos',
    link: true,
    get: ['Original video files'],
    label: 'Vimeo',
    kind: 'video',
    steps: ["Download your original from your video's page on Vimeo."],
  },
  {
    id: 'bandcamp',
    what: 'Releases',
    link: false,
    get: ['Your releases'],
    label: 'Bandcamp',
    kind: 'music',
    steps: ['Use your original audio files; your purchases are downloadable from your collection.'],
  },
  {
    id: 'substack',
    what: 'Posts and subscribers',
    link: false,
    get: ['Posts', 'Subscriber list'],
    label: 'Substack',
    kind: 'archive',
    steps: ['Dashboard › Settings › Exports. Pick a text or PDF file from it.'],
  },
  {
    id: 'medium',
    what: 'Stories',
    link: false,
    get: ['Stories', 'Responses'],
    label: 'Medium',
    kind: 'archive',
    steps: ['Settings › Account › Download your information.'],
  },
  {
    id: 'github',
    what: 'Code and issues',
    link: true,
    get: ['Repositories', 'Issues and comments'],
    label: 'GitHub',
    kind: 'archive',
    steps: ['Export your account data from your GitHub settings, or save a README as text.'],
  },
  {
    id: 'spotify',
    what: 'Playlists and taste',
    link: true,
    get: ['Playlists', 'Listening history'],
    label: 'Spotify',
    kind: 'archive',
    steps: ['Account › Privacy settings › Download your data (playlists and history).'],
  },
  {
    id: 'takeout',
    what: 'Photos, mail, Drive',
    link: false,
    get: ['Google Photos', 'Gmail', 'Drive files', 'Location history'],
    label: 'Google Takeout',
    kind: 'picture',
    steps: ['Go to takeout.google.com and export Google Photos or YouTube. Pick a photo or video from it.'],
  },
  {
    id: 'icloud',
    what: 'Your photo library',
    link: false,
    get: ['Photos and videos'],
    label: 'iCloud Photos',
    kind: 'picture',
    steps: ['In Photos, select your pictures and choose File › Export.'],
  },
  {
    id: 'flickr',
    what: 'Photos',
    link: true,
    get: ['Photos and albums'],
    label: 'Flickr',
    kind: 'picture',
    steps: ['Request your Flickr data from your account settings, or save a photo directly.'],
  },
];

export const mintSource = (id: MintSourceId) => MINT_SOURCES.find((s) => s.id === id);
