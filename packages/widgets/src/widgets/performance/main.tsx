import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Performance } from "./Performance";

render(<Performance bridge={createBridge(window, { appName: "portfolio-performance" })} />, document.getElementById("app")!);
