import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Activity } from "./Activity";

render(<Activity bridge={createBridge(window, { appName: "portfolio-activity" })} />, document.getElementById("app")!);
