import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { ReportCard } from "./ReportCard";

render(<ReportCard bridge={createBridge(window, { appName: "portfolio-report-card" })} />, document.getElementById("app")!);
