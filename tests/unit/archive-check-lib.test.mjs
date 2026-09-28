/** Pure-function unit tests for the archive-check job's non-network helpers:
 * HTML text extraction (scripts/lib/html-text.mjs) and the Wayback snapshot-URL
 * parser/builder (scripts/lib/wayback.mjs). No database, no network. */
import test from 'node:test';import assert from 'node:assert/strict';
import {extractHtmlText} from '../../scripts/lib/html-text.mjs';
import {parseArchiveUrlHint,snapshotUrl,toWaybackTimestamp,availableUrl} from '../../scripts/lib/wayback.mjs';

// --- extractHtmlText ---
test('drops script and style contents entirely, keeps body text',()=>{
 const html='<html><head><style>.x{color:red}</style></head><body><script>doEvil()</script><p>Hello world.</p></body></html>';
 assert.equal(extractHtmlText(html),'Hello world.');
});
test('drops noscript and template contents',()=>{
 const html='<div><noscript>enable js</noscript><template>ghost content</template><p>Real text</p></div>';
 assert.equal(extractHtmlText(html),'Real text');
});
test('strips HTML comments, including ones that look like tags',()=>{
 const html='<p>before</p><!-- <script>evil()</script> --><p>after</p>';
 assert.equal(extractHtmlText(html),'before after');
});
test('replaces remaining tags with a space, so adjacent inline elements do not glue words together',()=>{
 const html='<p>one</p><p>two</p><span>three</span>four';
 assert.equal(extractHtmlText(html),'one two three four');
});
test('decodes the common named entities and numeric entities',()=>{
 const html='<p>Tom &amp; Jerry &lt;3 &quot;friends&quot; &#39;forever&#39; &nbsp;&#x2764;</p>';
 assert.equal(extractHtmlText(html),'Tom & Jerry <3 "friends" \'forever\' ❤');
});
test('collapses runs of whitespace and trims',()=>{
 const html='<p>  a   \n\n  b  \t c  </p>';
 assert.equal(extractHtmlText(html),'a b c');
});
test('plain text with no tags passes through, entities still decoded',()=>{
 assert.equal(extractHtmlText('just   text &amp; more'),'just text & more');
});

// --- wayback: parseArchiveUrlHint ---
test('parses a snapshot hint with the id_ flag',()=>{
 const r=parseArchiveUrlHint('https://web.archive.org/web/20230101120000id_/https://example.org/a?b=1');
 assert.deepEqual(r,{timestamp:'20230101120000',url:'https://example.org/a?b=1'});
});
test('parses a snapshot hint with no flag',()=>{
 const r=parseArchiveUrlHint('https://web.archive.org/web/20230101120000/https://example.org/a');
 assert.deepEqual(r,{timestamp:'20230101120000',url:'https://example.org/a'});
});
test('parses a snapshot hint with a short timestamp',()=>{
 const r=parseArchiveUrlHint('http://web.archive.org/web/2023/https://example.org/a');
 assert.deepEqual(r,{timestamp:'2023',url:'https://example.org/a'});
});
test('rejects a non-wayback URL',()=>{
 assert.equal(parseArchiveUrlHint('https://example.org/a'),null);
});
test('rejects a malformed hint (no path after the timestamp segment)',()=>{
 assert.equal(parseArchiveUrlHint('https://web.archive.org/web/20230101120000id_/'),null);
});
test('rejects non-string input',()=>{
 assert.equal(parseArchiveUrlHint(null),null);
 assert.equal(parseArchiveUrlHint(undefined),null);
});

// --- wayback: snapshotUrl / toWaybackTimestamp / availableUrl ---
test('snapshotUrl builds the id_ raw-content URL',()=>{
 assert.equal(snapshotUrl('20230101120000','https://example.org/a'),'https://web.archive.org/web/20230101120000id_/https://example.org/a');
});
test('toWaybackTimestamp formats UTC as YYYYMMDDhhmmss',()=>{
 assert.equal(toWaybackTimestamp('2023-01-02T03:04:05.000Z'),'20230102030405');
});
test('availableUrl encodes the target url and includes the timestamp',()=>{
 const u=availableUrl('https://example.org/a?b=1','20230101120000');
 assert.equal(u,'https://archive.org/wayback/available?url=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1&timestamp=20230101120000');
});
