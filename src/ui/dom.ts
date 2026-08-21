/**
 * The one DOM lookup shared by the three UI entry points (popup, options,
 * onboarding).
 *
 * Each page ships with its own .html in the same repo, so an id that is not
 * there is a markup bug, not a runtime condition: throwing on load surfaces it
 * immediately instead of making every call site re-check for `null`. The
 * message names the page by its own path so one shared helper still says which
 * markup file is at fault.
 */
export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`${location.pathname} is missing #${id}`);
  return node as T;
}
