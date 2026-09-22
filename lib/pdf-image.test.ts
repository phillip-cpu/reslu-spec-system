import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import React from "react";
import { Document, Page, Image, renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, PDFName } from "pdf-lib";
import { normalizePdfImage, hasMissingPdfImages, PDF_IMAGE_SIZE } from "./pdf-image.ts";

const fixture = Buffer.from('<svg width="800" height="400"><rect width="800" height="400" fill="#a08c72"/><circle cx="400" cy="200" r="150" fill="#313131"/></svg>');
const jxl = Buffer.from('/wpDwE4BvAH5PAAAVKiMMm7wcq7nyw8dFtM2rjO01bYFAAAA8AD6lVBg28iPHIvBCXhesGAxJDCi1sXTxbtrxQlxDCcACKTVtm3btm3btm3btm3btm3btm3btm3btm2bJQEDgPgabAQwwAAEAEbPZwsAALFEJQk=', 'base64');
const bytesFromDataUrl = (url: string) => Buffer.from(url.split(",")[1], "base64");

test("JPEG, PNG, WebP, GIF, AVIF, SVG and JPEG XL all embed as PDF images", async () => {
  const sources = await Promise.all([
    sharp(fixture).jpeg().toBuffer(), sharp(fixture).png().toBuffer(),
    sharp(fixture).webp().toBuffer(), sharp(fixture).gif().toBuffer(),
    sharp(fixture).avif().toBuffer(), Promise.resolve(fixture), Promise.resolve(jxl),
  ]);
  for (const source of sources) {
    const uri = await normalizePdfImage(source);
    const meta = await sharp(bytesFromDataUrl(uri)).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width! <= PDF_IMAGE_SIZE && meta.height! <= PDF_IMAGE_SIZE);
    const pdf = await renderToBuffer(React.createElement(Document, {},
      React.createElement(Page, {}, React.createElement(Image, {src: uri, style: {width: 40, height: 40}}))));
    const loaded = await PDFDocument.load(pdf);
    const images = loaded.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"));
    assert.ok(images && images.toString().includes("/I1"), "renderer must embed the image, not silently skip it");
  }
});

test("large originals become small renditions with aspect ratio and no upscaling", async () => {
  const pixels = Buffer.alloc(1600 * 1200 * 3);
  for (let i=0; i<pixels.length; i++) pixels[i] = (i * 73 + (i >> 7)) % 256;
  const original = await sharp(pixels, {raw: {width:1600,height:1200,channels:3}}).png().toBuffer();
  const output = bytesFromDataUrl(await normalizePdfImage(original));
  assert.ok(output.length < original.length / 10);
  const meta = await sharp(output).metadata();
  assert.equal(meta.width, 256); assert.equal(meta.height, 192);
  const small = await sharp({create:{width:20,height:10,channels:3,background:"white"}}).png().toBuffer();
  assert.equal((await sharp(bytesFromDataUrl(await normalizePdfImage(small))).metadata()).width,20);
});

test("transparent pixels use the schedule background and EXIF rotation is applied", async () => {
  const transparent = await sharp({create:{width:8,height:8,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  const {data} = await sharp(bytesFromDataUrl(await normalizePdfImage(transparent))).raw().toBuffer({resolveWithObject:true});
  assert.ok(Math.abs(data[0]-237)<3 && Math.abs(data[1]-232)<3 && Math.abs(data[2]-222)<3);
  const rotated = await sharp(fixture).jpeg().withMetadata({orientation:6}).toBuffer();
  const meta = await sharp(bytesFromDataUrl(await normalizePdfImage(rotated))).metadata();
  assert.equal(meta.width,128); assert.equal(meta.height,256);
  assert.equal(meta.orientation,undefined);
});

test("broken images reject and incomplete exports cannot enter the PDF cache", async () => {
  await assert.rejects(normalizePdfImage(Buffer.from('not an image')));
  const items = [{id:"a",selected_image_url:"https://example.com/a.webp"},{id:"b",selected_image_url:null}];
  assert.equal(hasMissingPdfImages(items,new Map()),true);
  assert.equal(hasMissingPdfImages(items,new Map([["a","data:image/jpeg;base64,ok"]])),false);
  assert.equal(hasMissingPdfImages([items[1]],new Map()),false);
});
