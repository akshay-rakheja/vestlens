import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Thesis } from "./Thesis";

render(<Thesis bridge={createBridge(window, { appName: "portfolio-thesis" })} />, document.getElementById("app")!);
