/** QIVVRA only assures a build it can prove is running: the QE environment must report the PR head at /version. */
export async function waitForCommit(baseUrl: string, sha: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  let observed: unknown = null;
  for (;;) {
    try {
      observed = await (await fetch(new URL('/version', baseUrl))).json();
      if ((observed as { gitSha?: string }).gitSha === sha) return { confirmed: true, observed };
    } catch (e) { observed = { error: String(e) }; }
    if (Date.now() > deadline) return { confirmed: false, observed };
    await new Promise((r) => setTimeout(r, 2000));
  }
}
