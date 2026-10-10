import { render } from "preact";
import { App } from "./app.tsx";
import { boot } from "./client.ts";
import { setTheme, theme } from "./theme.ts";
import "./app.css";

setTheme(theme.value);

const root = document.querySelector("#root");
if (!root) throw new Error("missing #root");
boot();
render(<App />, root);
