import { App, Editor, Modal, Plugin, Setting } from 'obsidian';

// use hardcoded string "p&q|-(r>s)<t|(-q^-s)" -> p and q or neg-(r implies s) iff t or (neg-q xor neg-s)
// Operator priority (highest - lowest): [~, &, |/^, >, <] (all xor operations must be wrapped in parentheses)
// Generating RPN (first list = operating stack, second list = pending operation stacks (matrix, [paren level][operations])):
// 1  - [p], 0: []
// 2  - [p], 0: [&]
// 3  - [p, q], 0: [&]
// 4  - [p, q, &], 0: [|]
// 5  - [p, q, &], 0: [|, ~]
// 6  - [p, q, &], 0: [|, ~], 1: []
// 7  - [p, q, &, r], 0: [|, ~], 1: []
// 8  - [p, q, &, r], 0: [|, ~], 1: [>]
// 9  - [p, q, &, r, s], 0: [|, ~], 1: [>]
// 10 - [p, q, &, r, s, >], 0: [|, ~]
// 11 - [p, q, &, r, s, >, ~, |], 0: [<]
// 12 - [p, q, &, r, s, >, ~, |, t], 0: [<]
// 13 - [p, q, &, r, s, >, ~, |, t], 0: [<, |]
// 14 - [p, q, &, r, s, >, ~, |, t], 0: [<, |], 1: []
// 15 - [p, q, &, r, s, >, ~, |, t], 0: [<, |], 1: [~]
// 16 - [p, q, &, r, s, >, ~, |, t, q], 0: [<, |], 1: [~]
// 17 - [p, q, &, r, s, >, ~, |, t, q, ~], 0: [<, |], 1: [^]
// 18 - [p, q, &, r, s, >, ~, |, t, q, ~], 0: [<, |], 1: [^, ~]
// 19 - [p, q, &, r, s, >, ~, |, t, q, ~, s], 0: [<, |], 1: [^, ~]
// 20 - [p, q, &, r, s, >, ~, |, t, q, ~, s, ~, ^], 0: [<, |]
// 21 - [p, q, &, r, s, >, ~, |, t, q, ~, s, ~, ^, |, <]
// reverse-polish-notation: [p, q, &, r, s, >, ~, |, t, q, ~, s, ~, ^, |, <]
// p=1, q=0, r=1, s=0, t=1
// Evaluation:
// [1, 0, &, 1, 0, >, ~, |, 1, 1, ~, 0, ~, ^, |, <]
// [0, 1, 0, >, ~, |, 1, 1, ~, 0, ~, ^, |, <]
// [0, 0, ~, |, 1, 1, ~, 0, ~, ^, |, <]
// [0, 1, |, 1, 1, ~, 0, ~, ^, |, <]
// [1, 1, 1, ~, 0, ~, ^, |, <]
// [1, 1, 0, 0, ~, ^, |, <]
// [1, 1, 0, 1, ^, |, <]
// [1, 1, 1, |, <]
// [1, 1, <]
// [1]

type RPN = {
    data: string[];
    codeVars: string[];
    mathToCodeVars: {[mathVar: string]: string};
    codeToMathVars: {[codeVar: string]: string};
    variableCount: number;
}

const operators: {[operator: string]: {priority: number, latex: string}} = {
    "~": {
        priority: 5,
        latex: "\\neg{}"
    },
    "&": {
        priority: 4,
        latex: "\\land{}"
    },
    "|": {
        priority: 3,
        latex: "\\lor{}"
    },
    "^": {
        priority: 3,
        latex: "\\oplus{}"
    },
    ">": {
        priority: 2,
        latex: "\\implies{}"
    },
    "<": {
        priority: 1,
        latex: "\\iff{}"
    }
}

function generateRPN(proposition: string) : RPN {
    const filteredProp = proposition.trim();
    const rpn: RPN = {
        data: [],
        codeVars: [],
        mathToCodeVars: {},
        codeToMathVars: {},
        variableCount: 0
    };
    const pendingOperations: string[][] = [[]];
    let parenLevel = 0;
    
    for (let i = 0; i < filteredProp.length; i++) {
        const token = filteredProp.charAt(i);
        console.log("Processing token \"" + token + "\"")
        let pendingOperationsAtLevel = pendingOperations[parenLevel];
        // Check for parentheses level change
        if (token === "(") {
            parenLevel++;
            continue;
        }
        if (token === ")") {
            while (pendingOperationsAtLevel.length > 0) {
                rpn.data.push(pendingOperationsAtLevel.pop()!)
            }
            parenLevel--;
            continue;
        }
        // Handle operators
        if (token in operators) {
            if (pendingOperationsAtLevel === undefined || pendingOperationsAtLevel.length === 0) {
                pendingOperationsAtLevel = [token];
                pendingOperations[parenLevel] = pendingOperationsAtLevel;
                console.log(JSON.stringify(pendingOperations))
                continue;
            }
            while (pendingOperationsAtLevel.length > 0
                    && operators[pendingOperationsAtLevel.last()!].priority > operators[token].priority) {
                rpn.data.push(pendingOperationsAtLevel.pop()!)
            }
            pendingOperationsAtLevel.push(token);
            pendingOperations[parenLevel] = pendingOperationsAtLevel;
            console.log(JSON.stringify(pendingOperations))
            continue;
        }

        // Handle variables, only remaining option
        if (!(token in rpn.mathToCodeVars)) {
            const codeVar = "var" + ++rpn.variableCount;
            rpn.codeVars.push(codeVar);
            rpn.mathToCodeVars[token] = codeVar;
            rpn.codeToMathVars[codeVar] = token;
        }
        rpn.data.push(rpn.mathToCodeVars[token]);
    }
    while (pendingOperations[parenLevel].length > 0) {
        rpn.data.push(pendingOperations[parenLevel].pop()!);
    }
    console.log(rpn);
    return rpn;
}

const intToChar: {[num: number]: string} = {
    0: "F",
    1: "T"
}

function generateTruthTable(rpn: RPN) : string {
    let table = "| ";
    // Generate table header
    table += Object.keys(rpn.mathToCodeVars).join(",")
    table += " |"

    let headerDivider = "|-|";

    // Simulate going through RPN to determine table headers for each operation
    const simulatedOperatingStack: string[] = [];
    console.log(rpn.data);
    for (const token of rpn.data) {
        if (token in operators) {
            let operation: string;
            if (token === "~") {
                operation = "\\overline{" + simulatedOperatingStack.pop() + "}"
            } else {
                const rhs = simulatedOperatingStack.pop();
                operation = simulatedOperatingStack.pop() + operators[token].latex + rhs;
            }
            table += " $" + operation + "$ |"
            headerDivider += "-|";
            simulatedOperatingStack.push(operation);
        } else {
            simulatedOperatingStack.push(rpn.codeToMathVars[token]);
        }
    }

    table += "\n" + headerDivider;

    // Time to *actually* run the RPN
    // Convert string RPN to variable indexes for values array
    console.log(rpn.codeVars);
    const convertedRPNData: (string | number)[] = rpn.data.map(value => {
        return rpn.codeVars.includes(value) ? rpn.codeVars.indexOf(value) : value;
    })

    console.log(convertedRPNData);

    // Generate a list of values to use during simulations based on variable count
    const values: number[] = Array(rpn.variableCount).fill(0);
    for (let runNumber = 0; runNumber < 2 ** rpn.variableCount; runNumber++) {
        let row = "|";
        const operatingStack: number[] = [];
        for (let i = 0; i < rpn.variableCount; i++) {
            if (runNumber % (2 ** (rpn.variableCount - i - 1)) === 0) {
                values[i] = Number(!values[i]);
            }
        }

        row += values.map(val => intToChar[val]).join(",");
        row += "|";

        for (const token of convertedRPNData) {
            console.log(`Run #${runNumber + 1}: ${JSON.stringify(operatingStack)}`)
            if (typeof token === "number") {
                operatingStack.push(values[token]);
                continue;
            }
            let value = 0;
            switch (token) {
                case "~": {
                    value = Number(!operatingStack.pop());
                    break;
                }
                case "&": {
                    const rhs = operatingStack.pop()!;
                    value = operatingStack.pop()! & rhs;
                    break;
                }
                case "|": {
                    const rhs = operatingStack.pop()!;
                    value = operatingStack.pop()! | rhs;
                    break;
                }
                case "^": {
                    const rhs = operatingStack.pop()!;
                    value = operatingStack.pop()! ^ rhs;
                    break;
                }
                case ">": {
                    const rhs = operatingStack.pop()!;
                    if (operatingStack.pop()! && !rhs) {
                        value = 0;
                    } else {
                        value = 1;
                    }
                    break;
                }
                case "<": {
                    const rhs = operatingStack.pop()!;
                    value = Number(operatingStack.pop()! === rhs);
                    break;
                }
            }
            row += intToChar[value] + "|";
            operatingStack.push(value);
        }
        table += "\n" + row;
    }

    return table;
}

// noinspection JSUnusedGlobalSymbols
export default class MyPlugin extends Plugin {
	async onload() {
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'generate-truth-table',
			name: 'Generate Truth Table',
			editorCallback: (editor: Editor) => {
                const currentLine = editor.getCursor().line;
                const prevData = editor.getLine(currentLine);
                new PropositionModal(this.app, (proposition) => {
                    const rpn = generateRPN(proposition);
                    const table = generateTruthTable(rpn);
                    editor.setLine(currentLine, prevData + "\n" + table);
                }).open();
			}
		});
		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}
}

class PropositionModal extends Modal {
    proposition: string;
    onSubmit: (proposition: string) => void;

	constructor(app: App, onSubmit: (proposition: string) => void) {
		super(app);
        this.onSubmit = onSubmit;
	}

	onOpen() {
		const {contentEl} = this;
        contentEl.createEl("h2", { text: "Generate new Truth Table" });
        contentEl.createEl("p", { text: "Enter the proposition to generate a truth table for." });
        contentEl.createEl("p", { text: "The following symbols are used to represent logical operators:" });
        const symbolList = contentEl.createEl("ul");
        symbolList.createEl("li", { text: "~ - NOT" });
        symbolList.createEl("li", { text: "& - AND" });
        symbolList.createEl("li", { text: "| - OR" });
        symbolList.createEl("li", { text: "^ - XOR" });
        symbolList.createEl("li", { text: "> - Implies" });
        symbolList.createEl("li", { text: "< - If and only if" });
        contentEl.createEl("p", { text: "Parentheses are also supported." })

        new Setting(contentEl)
            .setName("Proposition")
            .addText((text) => {
                text.onChange((value) => {
                    this.proposition = value;
                });
                text.setPlaceholder("ex.: p&q|~r")
            });

        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText("Generate Truth Table")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.onSubmit(this.proposition);
                    })
            })
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
