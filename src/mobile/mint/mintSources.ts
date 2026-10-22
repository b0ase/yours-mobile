import type { MintKind } from './mintKinds';

/**
 * "Mint what you already post" (owner, 22 Oct 2026): a row of platforms on the mint-by-type step. Tapping one
 * shows how to get the file of your own post out of that platform, then picks the matching type. Nothing is
 * fetched from the platform; the person downloads their file and picks it as usual.
 */
export type MintSourceId = 'youtube' | 'x' | 'instagram' | 'tiktok' | 'facebook' | 'linkedin' | 'soundcloud';

export type MintSource = { id: MintSourceId; label: string; kind: MintKind; steps: string[] };

export const MINT_SOURCES: MintSource[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    kind: 'video',
    steps: ['In YouTube Studio, open Content, then ⋮ › Download on your video.'],
  },
  {
    id: 'x',
    label: 'X',
    kind: 'picture',
    steps: [
      'Save the image straight from your post.',
      'For everything: Settings › Your account › Download an archive of your data. Your photos and videos are in it.',
    ],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    kind: 'picture',
    steps: [
      'Settings › Accounts Center › Your information and permissions › Download your information. Your photos and videos are in it.',
    ],
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    kind: 'video',
    steps: ['Open your video, tap Share › Save video.'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    kind: 'picture',
    steps: [
      'Open your photo, then ⋯ › Download.',
      'For everything: Settings › Accounts Center › Download your information.',
    ],
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    kind: 'picture',
    steps: [
      'Save the image straight from your post.',
      'For everything: Settings › Data privacy › Get a copy of your data.',
    ],
  },
  {
    id: 'soundcloud',
    label: 'SoundCloud',
    kind: 'music',
    steps: ['Your original upload: on your track, open ⋯ › Edit › Advanced and turn on downloads, then Download file.'],
  },
];

export const mintSource = (id: MintSourceId) => MINT_SOURCES.find((s) => s.id === id);
