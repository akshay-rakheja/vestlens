import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Holdings } from "./Holdings";

render(<Holdings bridge={createBridge(window, { appName: "portfolio-holdings" })} />, document.getElementById("app")!);
