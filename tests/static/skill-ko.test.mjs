/** SOURCE-ONLY: reads source text, no build or DB required. Korean translation of the agent guide. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import nodePath from 'node:path';

const rootDir=fileURLToPath(new URL('../../',import.meta.url));
const path=(...p)=>nodePath.join(rootDir,...p);
const read=p=>readFileSync(path(p),'utf8');

const EN_PATH='public/skill.md';
const KO_PATH='public/skill.ko.md';

test('the Korean translation file exists',()=>{
 assert.ok(existsSync(path(KO_PATH)),`${KO_PATH} is missing`);
});

const en=read(EN_PATH);
const ko=read(KO_PATH);

const sections=text=>[...text.matchAll(/^## .*$/gm)].map(m=>m[0]);

test('the Korean translation has the same number of ## sections as the English guide, in the same order',()=>{
 const enSections=sections(en);
 const koSections=sections(ko);
 assert.equal(koSections.length,enSections.length,`expected ${enSections.length} '## ' sections, found ${koSections.length}`);
 assert.deepEqual(koSections,enSections,'section headings must match the English guide 1:1, in order');
});

test('the Korean translation states the English guide is authoritative',()=>{
 assert.match(ko,/영어판.*(기준|우선)/);
});
