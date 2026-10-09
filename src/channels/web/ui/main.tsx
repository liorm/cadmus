import { render } from "preact";
import { App } from "./app.tsx";
import { boot } from "./client.ts";
import "./app.css";

const root = document.querySelector("#root");
if (!root) throw new Error("missing #root");
boot();
render(<App />, root);
