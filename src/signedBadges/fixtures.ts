/**
 * A real AuthSig proof from BSV mainnet (public data, read from the overlay ls_kvstore on 1 Nov 2026): a post on X
 * signed with AuthSig 1.0.2. Token 1b1f038e6d6658eb8c11976e4509d2714e7453e5f1572214e3d547f610985a70.0.
 * Used by the tests to prove we read AuthSig's records byte for byte.
 */
export const AUTHSIG_MAINNET_RECORD = {
  key: 'x-post-2116316140108648629',
  controller: '023a1bd85f0abeab68c109acb79be62abf2c402627b9a032ffdfab39b9806490af',
  protocolID: [1, 'authsig'] as [number, string],
  token: { txid: '1b1f038e6d6658eb8c11976e4509d2714e7453e5f1572214e3d547f610985a70', outputIndex: 0 },
  value:
    '{"signature":"30440220027e1816b3fd64d69c477a8c83fba91afee118c0b6ddf67ac0b58b5b2393851e02207e45f7b176809a0009a2f80ee8a67e812c99755c37359f32f61fde5d59188d48","publicKey":"023a1bd85f0abeab68c109acb79be62abf2c402627b9a032ffdfab39b9806490af","signedAt":"2026-10-30T23:47:49.955Z","protocol":"authsig-v1","content":"How many switch ports total","contentHash":"489b4ebc8413ca528505205378920579e01040937cf121cae1a6894d225c4362"}',
};
