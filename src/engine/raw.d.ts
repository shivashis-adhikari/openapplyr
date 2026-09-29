/** Vite inlines `?raw` imports as strings (used for scripts that run inside web pages). */
declare module '*?raw' {
  const content: string
  export default content
}
