import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Limits } from "./Limits";

render(<Limits bridge={createBridge(window, { appName: "portfolio-limits" })} />, document.getElementById("app")!);
