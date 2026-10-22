/** Display-only reduction of import audit prose. Stored source records stay intact. */
export function scheduleProductNote(value:string|null|undefined):string|null {
 if(!value)return null;
 const sentences=value.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/);
 const useful=sentences.flatMap(sentence=>{
  const text=sentence.trim();
  if(!text)return [];
  if(/^(?:Reece reference code|Source(?:\b|:)|Source-package|Imported?\b|Import provenance|Product photograph verified|Photograph permanently stored|Dimension verification|Verified (?:by|on|from|image)|SHA\s*-?256|\d{4}-\d{2}-\d{2}\.?$)/i.test(text))return [];
  if(/\b(?:SHA\s*-?256|[a-f0-9]{64}|storage\/v1\/object|product-image bucket|media\/image_\d+)\b/i.test(text))return [];
  if(/^No distinct manufacturer SKU verified\.?$/i.test(text))return ['Manufacturer SKU unconfirmed.'];
  if(/^Reece product code is separate from manufacturer SKU\.?$/i.test(text))return [];
  // URLs and source filenames belong to the document links, not prose notes.
  const cleaned=text.replace(/https?:\/\/\S+/gi,'').replace(/\S+\.(?:pptx?|pdf|png|jpe?g|webp|bmp)\b/gi,'').trim();
  return cleaned&&/[a-z]/i.test(cleaned)?[cleaned]:[];
 });
 return useful.join(' ')||null;
}
