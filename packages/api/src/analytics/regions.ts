export type Region = "Canada" | "United States" | "Developed ex-North America" | "Emerging markets" | "Other";

const DEVELOPED = new Set([
  "united kingdom", "uk", "germany", "france", "japan", "australia", "switzerland", "netherlands", "italy", "spain", "sweden", "denmark",
  "norway", "finland", "ireland", "belgium", "austria", "portugal", "israel", "hong kong", "singapore", "new zealand", "luxembourg",
]);
const EMERGING = new Set([
  "china", "india", "brazil", "mexico", "south africa", "taiwan", "south korea", "korea", "indonesia", "thailand", "malaysia", "philippines",
  "turkey", "saudi arabia", "united arab emirates", "poland", "chile", "colombia", "peru", "greece", "czech republic", "hungary", "egypt",
  "qatar", "kuwait", "vietnam", "argentina",
]);

/** Maps a Yahoo country name to a coarse region; unknown names are "Other". */
export function regionOf(country: string): Region {
  const c = country.trim().toLowerCase();
  if (c === "canada") return "Canada";
  if (c === "united states" || c === "usa" || c === "us" || c === "united states of america") return "United States";
  if (DEVELOPED.has(c)) return "Developed ex-North America";
  if (EMERGING.has(c)) return "Emerging markets";
  return "Other";
}
