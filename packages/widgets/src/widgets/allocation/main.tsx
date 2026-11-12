import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Allocation } from "./Allocation";

render(<Allocation bridge={createBridge(window, { appName: "portfolio-allocation" })} />, document.getElementById("app")!);
