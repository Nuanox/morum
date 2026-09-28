import test from 'node:test';
import assert from 'node:assert/strict';
import {isUrlQuery} from '../../src/components/universe/url-query.ts';

test('an https URL is returned as-is', () => {
  assert.equal(isUrlQuery('https://arxiv.org/abs/2304.09848'), 'https://arxiv.org/abs/2304.09848');
});

test('a bare domain is prefixed with https://', () => {
  assert.equal(isUrlQuery('arxiv.org'), 'https://arxiv.org');
});

test('a bare domain with a path keeps the path', () => {
  assert.equal(isUrlQuery('arxiv.org/abs/2304.09848'), 'https://arxiv.org/abs/2304.09848');
});

test('a Korean word is not a URL', () => {
  assert.equal(isUrlQuery('안녕하세요'), null);
});

test('a word with a dot like a version number is not a URL', () => {
  assert.equal(isUrlQuery('v2.1'), null);
});

test('localhost alone is not a URL', () => {
  assert.equal(isUrlQuery('localhost'), null);
});

test('an email-like string is not a URL', () => {
  assert.equal(isUrlQuery('a@b.com'), null);
});
