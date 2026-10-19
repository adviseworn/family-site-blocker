// The person's own list of blocked sites ("Your blocked sites" on the settings page). It is kept as the
// extension's dynamic rules and nowhere else: reading the rules back gives the list, and saving the list
// replaces the rules. The settings page and the record page both change it through these two functions.
import { buildRules, domainsOf } from './rules.js';

// Set in storage (to the time) whenever the list is changed from the record page, so an open settings
// page knows to show the new list. The rules themselves give no event.
export const MY_LIST_CHANGED = 'myListChanged';

/** The domains on the person's own list, in the order they were saved. */
export async function myList(dnr) {
  return domainsOf(await dnr.getDynamicRules());
}

/** Replaces the person's own list with `domains` (already normalized, see lib/domains.js). */
export async function saveMyList(dnr, domains) {
  const existing = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: buildRules(domains),
  });
}

/** Adds one domain to the person's own list, if it isn't there; returns whether it was added. */
export async function addToMyList(dnr, domain) {
  const mine = await myList(dnr);
  if (mine.includes(domain)) return false;
  await saveMyList(dnr, [...mine, domain]);
  return true;
}
