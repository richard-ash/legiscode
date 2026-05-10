// Ambient declaration for plain `.css` side-effect imports. Vite picks
// these up natively in the renderer build (and inlines them into the
// bundle); TypeScript needs the type hint so component-scoped stylesheets
// like `import "./section-view.css"` typecheck.
declare module "*.css";
