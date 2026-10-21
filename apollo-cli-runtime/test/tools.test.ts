import test from "node:test";
import assert from "node:assert/strict";
import { read, write } from "../src/rlm/mod.ts";
import {
	bs4,
	df,
	dotenv,
	http,
	httpx,
	math,
	numpy,
	pandas,
	pydantic,
	requests,
	scipy,
	toml,
	tomli,
	xml,
	yaml,
	z,
} from "../src/rlm/tools.ts";

test("tools: yaml parse and stringify", () => {
	const doc = yaml.parse("name: apollo\nversion: 1");
	assert.equal(doc.name, "apollo");
	assert.equal(doc.version, 1);
	const str = yaml.stringify({ key: "val" });
	assert.match(str, /key:\s*val/);
});

test("tools: zod / pydantic schema validation", () => {
	const schema = z.object({
		id: z.string(),
		count: z.number().default(0),
	});
	const parsed = schema.parse({ id: "test-1" });
	assert.equal(parsed.id, "test-1");
	assert.equal(parsed.count, 0);
	assert.equal(pydantic, z);
});

test("tools: dotenv parser", () => {
	const env = dotenv.parse("FOO=bar\n# comment\nBAZ=\"hello world\"\nNUM=42\n");
	assert.equal(env.FOO, "bar");
	assert.equal(env.BAZ, "hello world");
	assert.equal(env.NUM, "42");
});

test("tools: toml parser", () => {
	const data = toml.parse(`
title = "TOML Test"
count = 10
flag = true

[owner]
name = "ck"
`);
	assert.equal(data.title, "TOML Test");
	assert.equal(data.count, 10);
	assert.equal(data.flag, true);
	assert.equal(data.owner?.name, "ck");
	assert.equal(tomli, toml);
});

test("tools: xml and html tag extractors", () => {
	const html = '<div class="content"><a href="https://example.com">Link</a><p>Text</p></div>';
	const links = xml.findAttr(html, "a", "href");
	assert.deepEqual(links, ["https://example.com"]);
	const tags = xml.findTags(html, "p");
	assert.deepEqual(tags, ["Text"]);
	assert.equal(xml.stripTags("<p>Hello <b>World</b></p>"), "Hello World");
	assert.equal(bs4, xml);
});

test("tools: math, numpy, scipy functions", () => {
	const nums = [1, 2, 3, 4, 5];
	assert.equal(math.sum(nums), 15);
	assert.equal(math.mean(nums), 3);
	assert.equal(math.median(nums), 3);
	assert.equal(math.min(nums), 1);
	assert.equal(math.max(nums), 5);
	assert.equal(math.variance(nums), 2.5);
	assert.equal(numpy, math);
	assert.equal(scipy, math);
});

test("tools: pandas and DataFrame", () => {
	const table = pandas.DataFrame.from([
		{ name: "alice", age: 30, score: 95 },
		{ name: "bob", age: 25, score: 80 },
		{ name: "charlie", age: 35, score: 90 },
	]);
	const filtered = table.filter((r) => r.age >= 30).sort("score", false);
	assert.equal(filtered.count(), 2);
	assert.equal(filtered.head(1)[0].name, "alice");
	assert.equal(df, pandas);
});

test("tools: http, requests, httpx exports", () => {
	assert.equal(typeof http.get, "function");
	assert.equal(typeof http.post, "function");
	assert.equal(typeof http.fetch, "function");
	assert.equal(requests, http);
	assert.equal(httpx, http);
});
