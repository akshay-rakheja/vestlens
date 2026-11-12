import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Overview } from "./Overview";

render(<Overview bridge={createBridge(window, { appName: "portfolio-overview" })} />, document.getElementById("app")!);
