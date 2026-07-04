import path from "node:path";
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  Font,
} from "@react-pdf/renderer";
import type { Category, Item, Project } from "@/types";

// ── fonts (registered once) ─────────────────────────────────
// Cormorant Garamond — display/cover titles only (brand guide).
// Body/tables use the built-in Helvetica (Helvetica Neue Light is
// proprietary and can't be bundled; Helvetica is the closest standard
// PDF face). BUILD-SPEC.md §Brand.
let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  Font.register({
    family: "Cormorant",
    src: path.join(process.cwd(), "public/fonts/CormorantGaramond.ttf"),
  });
  Font.registerHyphenationCallback((word) => [word]); // no hyphenation
  fontsRegistered = true;
}

// Brand palette (BUILD-SPEC.md §Brand)
const CREAM = "#EDE8DE";
const OFFWHITE = "#F5F1E8";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";
const LINE = "#DCD6CC";

const LOGO_BLACK = path.join(process.cwd(), "public/reslu-logo.png");
const LOGO_WHITE = path.join(process.cwd(), "public/reslu-logo-white.png");

const styles = StyleSheet.create({
  cover: {
    backgroundColor: CREAM,
    padding: 64,
    flexDirection: "column",
    justifyContent: "space-between",
    height: "100%",
  },
  coverLogo: { width: 200 },
  coverTitle: {
    fontFamily: "Cormorant",
    fontSize: 52,
    color: NEARBLACK,
  },
  coverSub: {
    fontSize: 9,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    marginTop: 8,
  },
  coverMeta: { fontSize: 10, color: CHARCOAL, lineHeight: 1.6 },

  page: {
    backgroundColor: "#FFFFFF",
    paddingTop: 64,
    paddingBottom: 48,
    paddingHorizontal: 40,
    fontSize: 9,
    color: CHARCOAL,
  },
  runningHeader: {
    position: "absolute",
    top: 24,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingBottom: 6,
  },
  runningHeaderText: {
    fontSize: 7,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
  },
  pageNumber: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    textAlign: "center",
    fontSize: 7,
    color: SAND,
  },

  sectionLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 3,
    marginTop: 14,
    marginBottom: 8,
  },

  item: {
    flexDirection: "row",
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingVertical: 12,
  },
  imageBox: {
    width: 120,
    height: 120,
    backgroundColor: OFFWHITE,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: 120, height: 120, objectFit: "cover" },
  noImage: { fontSize: 7, color: SAND, textTransform: "uppercase", letterSpacing: 1 },

  details: { flex: 1 },
  codeRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  code: { fontSize: 10, fontFamily: "Helvetica-Bold", color: NEARBLACK },
  room: { fontSize: 8, color: SAND, textTransform: "uppercase", letterSpacing: 1 },
  name: { fontSize: 12, color: NEARBLACK, marginBottom: 4 },
  line: { fontSize: 9, color: CHARCOAL, lineHeight: 1.5 },
  metaLabel: { color: SAND },
  status: {
    marginTop: 6,
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: CHARCOAL,
  },
});

// ── helpers ─────────────────────────────────────────────────

function dimensions(item: Item): string | null {
  const parts = [item.width_mm, item.height_mm, item.length_mm, item.depth_mm]
    .filter((v): v is number => v !== null && v !== undefined)
    .map(String);
  return parts.length ? `${parts.join(" × ")} mm` : null;
}

/** Join present values with a separator, dropping blanks (suppress empties). */
function joinPresent(values: (string | null | undefined)[], sep = "  ·  ") {
  const present = values.filter((v): v is string => !!v && v.trim() !== "");
  return present.length ? present.join(sep) : null;
}

interface Props {
  project: Pick<Project, "name" | "client_name" | "address">;
  items: Item[];
  categories: Category[];
  generatedAt: string; // formatted date, passed in (server)
}

export function SchedulePdf({ project, items, generatedAt }: Props) {
  ensureFonts();

  // Group by location (room), Unassigned last — matches the register default.
  const map = new Map<string, Item[]>();
  for (const it of items) {
    const key = it.location?.trim() || "Unassigned";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  const groups = [...map.entries()].sort((a, b) => {
    if (a[0] === "Unassigned") return 1;
    if (b[0] === "Unassigned") return -1;
    return a[0].localeCompare(b[0]);
  });

  return (
    <Document title={`${project.name} — FF&E Schedule`}>
      {/* Cover — cream + black logo (brand guide) */}
      <Page size="A4" style={styles.cover}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={LOGO_BLACK} style={styles.coverLogo} />
        <View>
          <Text style={styles.coverTitle}>{project.name}</Text>
          <Text style={styles.coverSub}>FF&amp;E Schedule</Text>
        </View>
        <View style={styles.coverMeta}>
          <Text>{project.client_name}</Text>
          {project.address ? <Text>{project.address}</Text> : null}
          <Text>{generatedAt}</Text>
        </View>
      </Page>

      {/* Schedule pages */}
      <Page size="A4" style={styles.page}>
        <View style={styles.runningHeader} fixed>
          <Text style={styles.runningHeaderText}>{project.name}</Text>
          <Text style={styles.runningHeaderText}>FF&amp;E Schedule</Text>
        </View>

        {groups.map(([room, roomItems]) => (
          <View key={room}>
            <Text style={styles.sectionLabel}>{room}</Text>
            {roomItems.map((item) => {
              const supplierLine = joinPresent([item.brand, item.supplier]);
              const specLine = joinPresent([item.colour, item.material, item.finish]);
              const dims = dimensions(item);
              return (
                <View key={item.id} style={styles.item} wrap={false}>
                  <View style={styles.imageBox}>
                    {item.selected_image_url ? (
                      // eslint-disable-next-line jsx-a11y/alt-text
                      <Image src={item.selected_image_url} style={styles.image} />
                    ) : (
                      <Text style={styles.noImage}>No image</Text>
                    )}
                  </View>
                  <View style={styles.details}>
                    <View style={styles.codeRow}>
                      <Text style={styles.code}>
                        {item.item_code}
                        {"  "}
                        <Text style={styles.room}>Qty {item.quantity}</Text>
                      </Text>
                    </View>
                    <Text style={styles.name}>{item.name}</Text>
                    {supplierLine ? <Text style={styles.line}>{supplierLine}</Text> : null}
                    {specLine ? <Text style={styles.line}>{specLine}</Text> : null}
                    {dims ? <Text style={styles.line}>{dims}</Text> : null}
                    {item.application_note ? (
                      <Text style={styles.line}>{item.application_note}</Text>
                    ) : null}
                    {item.description ? (
                      <Text style={styles.line}>{item.description}</Text>
                    ) : null}
                    <Text style={styles.status}>{item.status}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        ))}

        <Text
          style={styles.pageNumber}
          render={({ pageNumber, totalPages }) =>
            `${pageNumber} / ${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  );
}

export { LOGO_WHITE }; // reserved for a future dark-cover variant
