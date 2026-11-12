import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { Calendar } from "./Calendar";

render(<Calendar bridge={createBridge(window, { appName: "portfolio-calendar" })} />, document.getElementById("app")!);
