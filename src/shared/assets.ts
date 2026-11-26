// Where the built bundles live, derived from the manifest's background entry.
//
// The extension root is the browser folder (firefox/ or chrome/), which holds
// the hand-written manifest.json plus the generated dist/ directory. Deriving
// the directory instead of hardcoding "dist/" means the same bundles also work
// if the manifest is ever placed next to them.
export function assetDir(manifest: any): string {
  const background = manifest?.background ?? {};
  const script: string = background.service_worker ?? background.scripts?.[0] ?? "";
  const slash = script.lastIndexOf("/");
  return slash === -1 ? "" : script.slice(0, slash + 1);
}
