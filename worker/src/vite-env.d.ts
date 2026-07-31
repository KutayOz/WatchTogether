// Vite's `?raw` suffix imports a file's contents as a string. Tests use it to
// load the real migration SQL rather than keeping a fixture copy that could
// drift from the schema that actually ships.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
