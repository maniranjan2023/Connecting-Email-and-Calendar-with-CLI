import endpoints from "./endpoints.json";

const gmailEndpoints = endpoints.gmail.endpoints;
const calendarEndpoints = endpoints.googlecalendar.endpoints;

console.log(`\n=== Endpoint Summary ===\n`);
console.log(`Gmail endpoints: ${gmailEndpoints.length}`);
console.log(`Google Calendar endpoints: ${calendarEndpoints.length}`);
console.log(`Total: ${gmailEndpoints.length + calendarEndpoints.length}\n`);

console.log("--- Gmail ---");
for (const ep of gmailEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log("\n--- Google Calendar ---");
for (const ep of calendarEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log(`\nRequired scopes (union):`);
const allScopes = new Set([
  ...gmailEndpoints.flatMap((e) => e.required_scopes),
  ...calendarEndpoints.flatMap((e) => e.required_scopes),
]);
for (const scope of allScopes) {
  console.log(`  ${scope}`);
}
