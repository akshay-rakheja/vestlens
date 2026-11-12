import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Goal } from "./Goal";

render(<Goal bridge={createBridge(window, { appName: "portfolio-goal" })} />, document.getElementById("app")!);
