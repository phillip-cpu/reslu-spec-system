import { suggestColumnMapping, parseCsvTable } from "./lib/csv.ts";
const headers = ["Code","Product Name","Brand","Colour","Qty","RRP","Trade Price","Product Link","Image"];
console.log("mapping:", JSON.stringify(suggestColumnMapping(headers), null, 0));
// money parse sanity via a mini import-shaped CSV
const csv = "Code,Product Name,RRP,Image,Product Link\nTW-01,Basin Mixer,\"$1,234.00\",https://cdn.x/img.jpg,https://x.com/p\n";
console.log("parsed headers:", JSON.stringify(parseCsvTable(csv).headers));
