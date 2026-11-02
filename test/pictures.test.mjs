// The picture filter: how scores become verdicts and a record (lib/pictures.js), the files it ships, and
// the classifier itself run in Node on two ordinary photos, which must come out as "neutral". There is no
// explicit photo here to check the other way; the real-browser tests use a stand-in classifier for that,
// and the Real pictures check (test/real-pictures.check.mjs) runs the model on real pictures at GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { BORDERLINE, CLASSES, COPIES_KEPT, COPIES_LENGTH, DEFAULT_STRICTNESS, LOOKS_KEPT, MAX_PICTURES, MIN_SIZE, STRICTNESS_CHOICES, THRESHOLD, URL_LENGTH, WHY_LENGTH, borderline, copiesByKey, copyKey, countHidden, describeHidden, hashOf, hiddenBySite, isData, isVideo, keepCopy, lookedAt, markAlike, markHidden, markedMistake, noteLook, recordHidden, sameGroups, sameHidden, samePicture, strictnessOf, verdict } from '../extension/lib/pictures.js';
import { hiddenWords, lookWords } from '../extension/lib/page.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));

test('pictures: nudity is hidden under both settings, suggestive only under the strict one, and the rest shown', () => {
  const nude = { drawing: 0.01, hentai: 0.02, neutral: 0.1, porn: 0.85, sexy: 0.02 };
  const drawn = { drawing: 0.3, hentai: 0.45, neutral: 0.2, porn: 0.03, sexy: 0.02 };
  const lingerie = { drawing: 0.01, hentai: 0.01, neutral: 0.3, porn: 0.08, sexy: 0.6 };
  const borderline = { drawing: 0.05, hentai: 0.05, neutral: 0.55, porn: 0.15, sexy: 0.2 }; // nudity 0.2, with sexy 0.4
  const cat = { drawing: 0.001, hentai: 0, neutral: 0.999, porn: 0, sexy: 0 };
  assert.deepEqual(verdict(nude, 'strict'), { hide: true, reason: 'nudity' });
  assert.deepEqual(verdict(nude, 'nudity'), { hide: true, reason: 'nudity' });
  assert.deepEqual(verdict(drawn, 'nudity'), { hide: true, reason: 'nudity' }, 'porn and hentai count together');
  assert.deepEqual(verdict(lingerie, 'strict'), { hide: true, reason: 'suggestive' });
  assert.deepEqual(verdict(lingerie, 'nudity'), { hide: false, reason: null });
  assert.deepEqual(verdict(borderline, 'strict'), { hide: true, reason: 'suggestive' }, `at the threshold (${THRESHOLD}) it is hidden`);
  assert.deepEqual(verdict(borderline, 'nudity'), { hide: false, reason: null });
  assert.deepEqual(verdict(cat, 'strict'), { hide: false, reason: null });
  assert.deepEqual(verdict(cat), verdict(cat, DEFAULT_STRICTNESS), 'the default setting');
  assert.deepEqual(verdict(undefined, 'strict'), { hide: false, reason: null }, 'no scores: shown');
  assert.deepEqual(verdict({ porn: 'x', sexy: NaN }, 'strict'), { hide: false, reason: null }, 'nonsense scores: shown');
  assert.equal(DEFAULT_STRICTNESS, 'strict', 'suggestive pictures are hidden unless the setting is changed');
  assert.deepEqual(STRICTNESS_CHOICES.map((c) => c.value), ['strict', 'nudity']);
  assert.equal(strictnessOf('nudity'), 'nudity');
  assert.equal(strictnessOf('off'), DEFAULT_STRICTNESS, 'there is no off');
  assert.equal(strictnessOf(undefined), DEFAULT_STRICTNESS);
  assert.deepEqual(CLASSES, ['drawing', 'hentai', 'neutral', 'porn', 'sexy'], "the model's output order");
  assert.equal(MIN_SIZE, 64);
});

test('pictures: a hidden picture is borderline when the score that decided it was under 0.6, the likelier mistake', () => {
  assert.equal(BORDERLINE, 0.6);
  assert.ok(THRESHOLD < BORDERLINE);
  assert.equal(borderline({ reason: 'nudity', scores: { porn: 0.9, hentai: 0.02, sexy: 0.02 } }), false);
  assert.equal(borderline({ reason: 'nudity', scores: { porn: 0.3, hentai: 0.23, sexy: 0.4 } }), true, 'nudity decided at 0.53; sexy does not count for it');
  assert.equal(borderline({ reason: 'suggestive', scores: { porn: 0.08, hentai: 0.01, sexy: 0.6 } }), false, 'suggestive decided at 0.69');
  assert.equal(borderline({ reason: 'suggestive', scores: { porn: 0.1, hentai: 0, sexy: 0.35 } }), true, 'suggestive decided at 0.45');
  assert.equal(borderline({ reason: 'suggestive', scores: {} }), true, 'no scores at all: nothing to be sure of');
});

test('pictures: the record of hidden pictures keeps rounded scores, caps its length, and sums up by site', () => {
  let record = recordHidden(undefined, { at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'suggestive', scores: { porn: 0.123456, hentai: 0.01, sexy: 0.5, neutral: 0.3, drawing: 0.01 } });
  assert.deepEqual(record, [{ at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'suggestive', scores: { porn: 0.12, hentai: 0.01, sexy: 0.5 } }]);
  record = recordHidden(record, { at: 2000, site: 'b.test', url: 'x'.repeat(900), reason: 'nudity', scores: { porn: 0.9 } });
  assert.equal(record[1].url.length, 500, 'long addresses are cut');
  assert.deepEqual(record[1].scores, { porn: 0.9, hentai: 0, sexy: 0 });
  record = recordHidden(record, { at: 3000, site: 'a.test', url: 'https://a.test/y.jpg', reason: 'nudity', scores: { porn: 0.7 } });
  assert.deepEqual(hiddenBySite(record), [
    { site: 'a.test', pictures: 2, last: 3000 },
    { site: 'b.test', pictures: 1, last: 2000 },
  ]);
  let many = [];
  for (let i = 0; i < MAX_PICTURES + 3; i += 1) many = recordHidden(many, { at: i, site: 's.test', url: `u${i}`, reason: 'nudity', scores: {} });
  assert.equal(many.length, MAX_PICTURES);
  assert.equal(many[0].url, 'u3', 'the oldest go');
  assert.deepEqual(hiddenBySite(undefined), []);
});

test('pictures: a row among every try says what was hidden and why, with the two scores the pages show (1.16.0)', () => {
  assert.equal(describeHidden({ reason: 'nudity', scores: { porn: 0.9, hentai: 0.02, sexy: 0.02 } }), 'Picture hidden for nudity: nudity 0.92, suggestive 0.02.');
  assert.equal(describeHidden({ reason: 'suggestive', scores: { porn: 0.1, hentai: 0, sexy: 0.35 }, kind: 'video' }), 'Video hidden as suggestive: nudity 0.10, suggestive 0.35.');
  assert.equal(describeHidden({ reason: 'other', scores: {} }), 'Picture hidden: nudity 0.00, suggestive 0.00.', 'a reason the pages do not know, and no scores');
  assert.equal(describeHidden({ scores: { porn: -1, sexy: 'x' } }), 'Picture hidden: nudity 0.00, suggestive 0.00.', 'junk scores count for nothing');
});

test('pictures: the pages sum the record up in the same words, for every site or for one (1.16.0)', () => {
  const when = (at) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let record = recordHidden(undefined, { at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'nudity', scores: { porn: 0.9 } });
  assert.equal(hiddenWords(record), `1 picture hidden on 1 site, the latest at ${when(1000)}.`);
  record = recordHidden(record, { at: 3000, site: 'b.test', url: 'https://b.test/clip.mp4', reason: 'suggestive', scores: { sexy: 0.45 }, kind: 'video' });
  record = recordHidden(record, { at: 2000, site: 'a.test', url: 'https://a.test/y.jpg', reason: 'nudity', scores: { porn: 0.5 } });
  assert.equal(hiddenWords(record), `2 pictures and 1 video hidden on 2 sites, the latest at ${when(3000)}. 2 of them are borderline.`, 'the latest by time, whatever the order stored');
  assert.equal(hiddenWords(record.filter((entry) => entry.site === 'a.test'), 'a.test'), `2 pictures hidden at a.test, the latest at ${when(2000)}. 1 of them is borderline.`);
  assert.equal(hiddenWords([]), '');
  assert.equal(hiddenWords(undefined), '');
});

test("pictures: a look at a hidden picture from the add-on's page, and the mark given after it, go on the picture's entry (1.17.0)", () => {
  let record = recordHidden(undefined, { at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'nudity', scores: { porn: 0.9 } });
  record = recordHidden(record, { at: 2000, site: 'a.test', url: 'https://a.test/y.jpg', reason: 'suggestive', scores: { sexy: 0.5 } });
  const key = { at: 2000, url: 'https://a.test/y.jpg' };
  assert.equal(sameHidden(record[1], key), true);
  assert.equal(sameHidden(record[0], key), false);
  assert.equal(sameHidden(record[1], { at: 2001, url: key.url }), false, 'the moment must match too');
  assert.equal(lookedAt(record[1]), false);
  const before = record;
  record = noteLook(record, key, { at: 5000, why: 'checking a close call' });
  assert.notEqual(record, before, 'a new list');
  assert.deepEqual(record[1].looks, [{ at: 5000, why: 'checking a close call' }]);
  assert.equal(record[1].url, key.url, 'the rest of the entry stays');
  assert.equal(record[0].looks, undefined, 'the other entry is untouched');
  assert.equal(lookedAt(record[1]), true);
  record = noteLook(record, key, { at: 6000, why: 'x'.repeat(300) });
  assert.equal(record[1].looks.length, 2);
  assert.equal(record[1].looks[1].why.length, WHY_LENGTH, 'a long reason is cut');
  assert.equal(noteLook(record, { at: 2000, url: 'https://a.test/other.jpg' }, { at: 7000, why: 'w' }), record, 'no such entry: the list as it was');
  assert.equal(noteLook(record, { at: 2001, url: key.url }, { at: 7000, why: 'w' }), record);
  assert.deepEqual(noteLook(undefined, key, { at: 1, why: 'w' }), []);
  let many = record;
  for (let i = 0; i < LOOKS_KEPT + 5; i += 1) many = noteLook(many, key, { at: 10_000 + i, why: `look ${i}` });
  assert.equal(many[1].looks.length, LOOKS_KEPT, 'the oldest looks go');
  assert.equal(many[1].looks[LOOKS_KEPT - 1].why, `look ${LOOKS_KEPT + 4}`);
  assert.equal(many[1].looks[0].why, 'look 5', 'the two looks from before went first');
  assert.equal(noteLook(record, key, { at: 8000, why: undefined })[1].looks[2].why, '', 'no reason is kept as none');

  assert.equal(markedMistake(record[1]), false);
  record = markHidden(record, key, { at: 8000, mistake: true });
  assert.deepEqual(record[1].mark, { at: 8000, mistake: true });
  assert.equal(markedMistake(record[1]), true);
  assert.equal(record[1].looks.length, 2, 'the looks stay');
  record = markHidden(record, key, { at: 9000, mistake: false });
  assert.deepEqual(record[1].mark, { at: 9000, mistake: false }, 'the latest mark replaces the earlier');
  assert.equal(markedMistake(record[1]), false);
  assert.equal(markHidden(record, key, { at: 9500, mistake: 'yes' })[1].mark.mistake, false, 'only true is a mistake');
  assert.equal(markHidden(record, { at: 1, url: 'u' }, { at: 1, mistake: true }), record, 'no such entry: the list as it was');
  assert.equal(record[0].mark, undefined);
});

test('pictures: the row says of the looks and the mark, and the summary counts the pictures looked at and the mistakes (1.17.0)', () => {
  const when = (at) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let record = recordHidden(undefined, { at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'nudity', scores: { porn: 0.9 } });
  record = recordHidden(record, { at: 2000, site: 'a.test', url: 'https://a.test/y.jpg', reason: 'suggestive', scores: { sexy: 0.5 } });
  record = recordHidden(record, { at: 3000, site: 'b.test', url: 'https://b.test/z.jpg', reason: 'nudity', scores: { porn: 0.7 } });
  assert.equal(lookWords(record[1]), '');
  assert.equal(hiddenWords(record), `3 pictures hidden on 2 sites, the latest at ${when(3000)}. 1 of them is borderline.`);
  record = noteLook(record, { at: 2000, url: 'https://a.test/y.jpg' }, { at: 5000, why: 'checking a close call' });
  assert.equal(lookWords(record[1]), `Looked at once, at ${when(5000)}: “checking a close call”.`);
  assert.equal(hiddenWords(record), `3 pictures hidden on 2 sites, the latest at ${when(3000)}. 1 of them is borderline. 1 looked at.`);
  record = markHidden(record, { at: 2000, url: 'https://a.test/y.jpg' }, { at: 6000, mistake: true });
  assert.equal(lookWords(record[1]), `Looked at once, at ${when(5000)}: “checking a close call”. Marked hidden by mistake at ${when(6000)}.`);
  assert.equal(hiddenWords(record), `3 pictures hidden on 2 sites, the latest at ${when(3000)}. 1 of them is borderline. 1 looked at, 1 marked hidden by mistake.`);
  assert.equal(hiddenWords(record.filter((entry) => entry.site === 'a.test'), 'a.test'), `2 pictures hidden at a.test, the latest at ${when(2000)}. 1 of them is borderline. 1 looked at, 1 marked hidden by mistake.`);
  assert.equal(hiddenWords(record.filter((entry) => entry.site === 'b.test'), 'b.test'), `1 picture hidden at b.test, the latest at ${when(3000)}.`, 'nothing looked at there');
  record = noteLook(record, { at: 2000, url: 'https://a.test/y.jpg' }, { at: 7000, why: '' });
  record = noteLook(record, { at: 2000, url: 'https://a.test/y.jpg' }, { at: 8000, why: 'again' });
  record = markHidden(record, { at: 2000, url: 'https://a.test/y.jpg' }, { at: 9000, mistake: false });
  assert.equal(lookWords(record[1]), `Looked at 3 times, the latest at ${when(8000)}: “again”. Marked rightly hidden at ${when(9000)}.`);
  assert.equal(hiddenWords(record), `3 pictures hidden on 2 sites, the latest at ${when(3000)}. 1 of them is borderline. 1 looked at.`, 'no longer a mistake');
  record = noteLook(record, { at: 1000, url: 'https://a.test/x.jpg' }, { at: 9500, why: '' });
  assert.equal(lookWords(record[0]), `Looked at once, at ${when(9500)}.`, 'a look with no reason');
  assert.equal(hiddenWords(record), `3 pictures hidden on 2 sites, the latest at ${when(3000)}. 1 of them is borderline. 2 looked at.`);
  assert.equal(lookWords({ looks: 'junk', mark: { mistake: 'yes' } }), '', 'junk says nothing');
});

test('pictures: a smaller copy of a hidden picture is kept under a key from the moment and the address as the record has them, the latest few, with an index (1.17.4)', () => {
  const long = `data:image/png;base64,${'A'.repeat(600)}`;
  assert.equal(isData(long), true);
  assert.equal(isData('http://x.test/a.png'), false);
  assert.equal(isData(undefined), false);
  const record = recordHidden([], { at: 1, site: 'x.test', url: long, reason: 'nudity', scores: { porn: 0.9 } });
  assert.match(copyKey(record[0]), /^pictureCopy:1:[0-9a-f]{8}$/);
  assert.equal(copyKey({ at: 1, url: long }), copyKey(record[0]), 'the whole address and the cut one name the same copy');
  assert.notEqual(copyKey({ at: 1, url: 'http://x.test/a.png' }), copyKey({ at: 1, url: 'http://x.test/b.png' }), 'two at the same moment are told apart');
  assert.notEqual(copyKey({ at: 2, url: long }), copyKey(record[0]));
  let { index, key, remove } = keepCopy(undefined, { at: 1, url: long, copy: 'data:image/jpeg;base64,one' });
  assert.deepEqual(index, [{ at: 1, url: long.slice(0, URL_LENGTH), length: 26, hash: hashOf('data:image/jpeg;base64,one') }], 'the index holds the address as the record keeps it, and the copy’s length and hash');
  assert.match(hashOf('data:image/jpeg;base64,one'), /^[0-9a-f]{8}$/);
  assert.equal(key, copyKey(record[0]), 'the copy goes under the record entry’s key');
  assert.deepEqual(remove, []);
  for (let i = 2; i <= COPIES_KEPT + 5; i += 1) ({ index, remove } = keepCopy(index, { at: i, url: long, copy: `copy ${i}` }));
  assert.equal(index.length, COPIES_KEPT);
  assert.equal(index[0].at, 6, 'the oldest go first');
  assert.deepEqual(remove, [copyKey({ at: 5, url: long })], 'each one let go is named, to be removed');
  // The size cap: big copies push out the rest, and the newest is kept whatever its size.
  const big = 'x'.repeat(COPIES_LENGTH / 2 + 1);
  ({ index, remove } = keepCopy(index, { at: 100, url: long, copy: big }));
  assert.equal(index.length, COPIES_KEPT, 'one big copy fits with the small ones');
  assert.equal(remove.length, 1);
  ({ index, remove } = keepCopy(index, { at: 101, url: long, copy: big }));
  assert.deepEqual(index.map((entry) => entry.at), [101], 'two together are over the cap: only the newest stays');
  assert.equal(remove.length, COPIES_KEPT, 'all the rest go');
  assert.ok(remove.includes(copyKey({ at: 100, url: long })));
  ({ index, remove } = keepCopy(index, { at: 102, url: long, copy: 'small' }));
  assert.deepEqual(index.map((entry) => entry.at), [101, 102]);
  assert.deepEqual(remove, []);
});

test('pictures: two rows show the same picture when their addresses are the same or their kept copies are, and a mark given to one goes to the rest (1.18.0)', () => {
  const entry = (at, url, extra = {}) => ({ at, site: 'x.test', url, reason: 'nudity', scores: { porn: 0.9, hentai: 0, sexy: 0 }, ...extra });
  const data = `data:image/png;base64,${'A'.repeat(600)}`.slice(0, URL_LENGTH);
  const copies = copiesByKey([
    { at: 1, url: 'http://x.test/a.jpg', length: 10, hash: 'aaaaaaaa' },
    { at: 3, url: 'http://x.test/c.jpg', length: 10, hash: 'aaaaaaaa' },
    { at: 4, url: data, length: 10, hash: 'dddddddd' },
    { at: 5, url: data, length: 10, hash: 'dddddddd' },
    { at: 6, url: 'http://x.test/f.jpg', length: 11, hash: 'aaaaaaaa' },
    { at: 7, url: 'http://x.test/g.jpg', length: 10, hash: '' },
    { at: 8, url: 'http://x.test/g.jpg', length: 10, hash: '' },
  ]);
  assert.equal(copies.get(copyKey({ at: 1, url: 'http://x.test/a.jpg' })).hash, 'aaaaaaaa');
  const a = entry(1, 'http://x.test/a.jpg');
  const a2 = entry(2, 'http://x.test/a.jpg'); // the same address again, no copy
  const c = entry(3, 'http://x.test/c.jpg'); // another address, the same copy as a
  const d = entry(4, data); // a data: address, the copy kept
  const d2 = entry(5, data); // the same start of a data: address, the same copy
  const f = entry(6, 'http://x.test/f.jpg'); // the same hash as a, another length: not the same
  const g = entry(7, 'http://x.test/g.jpg'); // copies gone from storage, hashed empty
  const g2 = entry(8, 'http://x.test/g.jpg'); // the same address: the same, by that alone
  const v = entry(9, 'http://x.test/a.jpg', { kind: 'video' }); // a video at a picture's address: never the same
  const v2 = entry(10, 'http://x.test/a.jpg', { kind: 'video' });
  assert.equal(samePicture(a, a2, copies), true, 'the same address');
  assert.equal(samePicture(a, c, copies), true, 'the same copy');
  assert.equal(samePicture(a2, c, copies), false, 'neither: a2 has no copy');
  assert.equal(samePicture(d, d2, copies), true, 'the same copy, under a data: address');
  assert.equal(samePicture(d, entry(11, data), copies), false, 'a data: address alone tells nothing: the record keeps only its start');
  assert.equal(samePicture(a, f, copies), false);
  assert.equal(samePicture(g, g2, copies), true);
  assert.equal(samePicture(g, entry(12, 'http://x.test/h.jpg'), copies), false, 'empty hashes match nothing');
  assert.equal(samePicture(a, v, copies), false);
  assert.equal(samePicture(v, v2, copies), false, 'videos are never the same: two on one page may share the page’s address');
  assert.equal(samePicture(a, a), true);
  assert.equal(samePicture(a, a2, undefined), true, 'with no index, addresses still tell');
  const record = [a, a2, c, d, d2, f, g, g2, v, v2];
  assert.deepEqual(
    sameGroups(record, copies).map((rows) => rows.map((row) => row.at)),
    [[10], [9], [8, 7], [6], [5, 4], [3, 2, 1]],
    'grouped by the picture, newest first: a2 and c are one picture through a, which shares an address with one and a copy with the other',
  );
  assert.deepEqual(sameGroups([], copies), []);
  assert.deepEqual(sameGroups(undefined, copies), []);
  // A mark goes to every row of the picture, and the others are left as they were; a key gone from the record is passed over.
  const marked = markAlike(record, [{ at: 2, url: 'http://x.test/a.jpg' }, { at: 99, url: 'http://x.test/gone.jpg' }], { at: 50, mistake: true }, copies);
  assert.deepEqual({ found: marked.found, alike: marked.alike }, { found: 1, alike: 2 });
  assert.deepEqual(marked.record.map((row) => row.mark?.mistake ?? null), [true, true, true, null, null, null, null, null, null, null]);
  assert.equal(marked.record[0].mark.at, 50);
  assert.equal(marked.record[3], d, 'the rest are the same objects');
  // Several at once, in one list; the latest mark replaces an earlier one, on every row; videos get theirs alone.
  const again = markAlike(marked.record, [{ at: 3, url: 'http://x.test/c.jpg' }, { at: 4, url: data }, { at: 9, url: 'http://x.test/a.jpg' }], { at: 60, mistake: false }, copies);
  assert.deepEqual({ found: again.found, alike: again.alike }, { found: 3, alike: 3 });
  assert.deepEqual(again.record.map((row) => (row.mark ? `${row.mark.mistake}@${row.mark.at}` : null)), ['false@60', 'false@60', 'false@60', 'false@60', 'false@60', null, null, null, 'false@60', null]);
  const none = markAlike(record, [{ at: 99, url: 'nowhere' }], { at: 70, mistake: true }, copies);
  assert.deepEqual({ found: none.found, alike: none.alike, same: none.record === record }, { found: 0, alike: 0, same: true }, 'nothing found: the list as it was');
  assert.deepEqual(markAlike(undefined, [], { at: 1, mistake: true }, copies), { record: [], found: 0, alike: 0 });
});

test('pictures: a hidden video is noted as one, counted apart in the summaries, and counted with the pictures by site', () => {
  let record = recordHidden(undefined, { at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'nudity', scores: { porn: 0.9 } });
  assert.equal(countHidden(record), '1 picture');
  record = recordHidden(record, { at: 2000, site: 'a.test', url: 'https://a.test/clip.mp4', reason: 'suggestive', scores: { sexy: 0.7 }, kind: 'video' });
  assert.deepEqual(record[1], { at: 2000, site: 'a.test', url: 'https://a.test/clip.mp4', reason: 'suggestive', scores: { porn: 0, hentai: 0, sexy: 0.7 }, kind: 'video' });
  assert.equal(isVideo(record[1]), true);
  assert.equal(isVideo(record[0]), false, 'a picture carries no kind');
  assert.equal(countHidden(record), '1 picture and 1 video');
  record = recordHidden(record, { at: 3000, site: 'b.test', url: 'https://b.test/page', reason: 'nudity', scores: { porn: 0.8 }, kind: 'video' });
  assert.equal(countHidden(record), '1 picture and 2 videos');
  assert.equal(countHidden(record.filter(isVideo)), '2 videos');
  assert.equal(countHidden([]), '0 pictures');
  assert.equal(countHidden(undefined), '0 pictures');
  assert.deepEqual(hiddenBySite(record), [
    { site: 'a.test', pictures: 2, last: 2000 },
    { site: 'b.test', pictures: 1, last: 3000 },
  ]);
  assert.equal(recordHidden([], { at: 1, site: 's', url: 'u', reason: 'nudity', scores: {}, kind: 'picture' })[0].kind, undefined, 'only video is a kind');
});

test('pictures: the content script runs in every page and frame from the start, and the model and its runtime ship with the add-on', () => {
  const [script] = manifest.content_scripts;
  assert.deepEqual(script, { matches: ['<all_urls>'], js: ['content.js'], css: ['content.css'], run_at: 'document_start', all_frames: true });
  assert.match(manifest.content_security_policy.extension_pages, /^script-src 'self' 'wasm-unsafe-eval'; object-src 'self';$/, 'WebAssembly allowed, nothing else loosened; no upgrade-insecure-requests, so a picture is fetched the way the page fetched it');
  for (const file of ['content.js', 'content.css', 'classifier.js', 'lib/pictures.js', 'vendor/tf.fesm.min.js', 'vendor/tf-global.js', 'vendor/tf-backend-wasm.min.js', 'vendor/tfjs-backend-wasm.wasm', 'vendor/tfjs-backend-wasm-simd.wasm', 'vendor/LICENSES.md', 'models/nsfw-mobilenet-v2/model.json']) {
    assert.ok(existsSync(join(EXT, file)), `${file} exists`);
  }
  const model = JSON.parse(readFileSync(join(EXT, 'models/nsfw-mobilenet-v2/model.json'), 'utf8'));
  for (const path of model.weightsManifest.flatMap((group) => group.paths)) {
    const size = readFileSync(join(EXT, 'models/nsfw-mobilenet-v2', path)).length;
    assert.ok(size > 0 && size < 4_000_000, `${path}: ${size} bytes, under the 4 MB Mozilla's linter allows a file`);
  }
  const licenses = readFileSync(join(EXT, 'vendor/LICENSES.md'), 'utf8');
  assert.ok(licenses.includes('Apache License') && licenses.includes('MIT License'), 'both licences are shipped');
  const css = readFileSync(join(EXT, 'content.css'), 'utf8');
  assert.match(css, /img:not\(\[data-family-site-blocker="ok"\]\):not\(\[data-family-site-blocker="small"\]\)\s*\{\s*visibility:\s*hidden\s*!important;/);
  assert.match(css, /video:not\(\[data-family-site-blocker="ok"\]\)\s*\{\s*visibility:\s*hidden\s*!important;/, 'a video is hidden until judged, too');
  assert.match(css, /\[style\*="url\(" i\]:not\(\[data-family-site-blocker="ok"\]\):not\(\[data-family-site-blocker="small"\]\)\s*\{\s*background-image:\s*none\s*!important;/, 'an element whose own style sets a picture as its background has none until judged (#80)');
  const content = readFileSync(join(EXT, 'content.js'), 'utf8');
  assert.match(content, /const WATCHED = 'img, video, \[style\*="url\(" i\]'/, 'the content script watches videos and background pictures as well as pictures');
  assert.match(content, /judge-video-frame/, 'and sends their frames to be judged');
  assert.doesNotMatch(readFileSync(join(EXT, 'vendor/tf.fesm.min.js'), 'utf8').slice(0, 20000), /\bimport\s+[\w$]+\s+from\s*"/, 'the runtime is self-contained');
});

test('pictures: the classifier, run here on two ordinary photos, finds them neutral (the model loads and is read the way the add-on reads it)', { timeout: 120_000 }, async () => {
  const tf = await import('@tensorflow/tfjs');
  const dir = join(EXT, 'models/nsfw-mobilenet-v2');
  const json = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
  const weightData = Buffer.concat(json.weightsManifest.flatMap((group) => group.paths).map((path) => readFileSync(join(dir, path))));
  const model = await tf.loadLayersModel({
    load: async () => ({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest.flatMap((group) => group.weights),
      weightData: weightData.buffer.slice(weightData.byteOffset, weightData.byteOffset + weightData.byteLength),
    }),
  });
  for (const file of ['cat.jpg', 'coffee.jpg']) {
    const { data, width, height } = jpeg.decode(readFileSync(join(ROOT, 'test/fixtures', file)), { useTArray: true });
    const scores = tf.tidy(() => {
      const rgb = tf.tensor3d(data, [height, width, 4], 'int32').slice([0, 0, 0], [height, width, 3]).toFloat().div(255);
      const out = model.predict(tf.image.resizeBilinear(rgb, [224, 224], true).expandDims(0));
      return (Array.isArray(out) ? out[0] : out).dataSync();
    });
    const named = Object.fromEntries(CLASSES.map((name, i) => [name, scores[i]]));
    assert.ok(named.neutral > 0.9, `${file}: ${JSON.stringify(named)}`);
    assert.deepEqual(verdict(named, 'strict'), { hide: false, reason: null }, file);
  }
  model.dispose();
});
