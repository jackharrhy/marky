export const CONNECTION_STRING: string =
  process.env.CONNECTION_STRING ?? "ys://127.0.0.1:8080";

if (process.env.CONNECTION_STRING) {
  console.log("Using config from environment variable CONNECTION_STRING");
} else {
  console.log("Using default connection string, ys://127.0.0.1:8080");
}
