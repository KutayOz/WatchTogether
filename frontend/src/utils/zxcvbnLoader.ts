/**
 * zxcvbn-ts is ~300KB of dictionary data. We only need it on Register /
 * InviteSignup pages, so this helper dynamic-imports it the first time
 * it's called and caches the resolved instance. Subsequent calls are
 * sync-fast (same Promise resolved value).
 *
 * Why one promise (not a flag): if two PasswordField mounts race the
 * first import we still only fetch once, and both await the same module.
 */

type ZxcvbnFn = (input: string) => { score: 0 | 1 | 2 | 3 | 4 };

let zxcvbnPromise: Promise<ZxcvbnFn> | null = null;

export function loadZxcvbn(): Promise<ZxcvbnFn> {
  if (!zxcvbnPromise) {
    zxcvbnPromise = (async () => {
      const [core, common, en] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
      ]);
      core.zxcvbnOptions.setOptions({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: {
          ...common.dictionary,
          ...en.dictionary,
        },
      });
      return ((input: string) => {
        const result = core.zxcvbn(input);
        return { score: result.score as 0 | 1 | 2 | 3 | 4 };
      }) satisfies ZxcvbnFn;
    })();
  }
  return zxcvbnPromise;
}
