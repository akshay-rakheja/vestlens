import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Income } from "./Income";

render(<Income bridge={createBridge(window, { appName: "portfolio-income" })} />, document.getElementById("app")!);
