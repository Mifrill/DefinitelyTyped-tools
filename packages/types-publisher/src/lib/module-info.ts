import assert = require("assert");
import * as path from "path";
import * as ts from "typescript";

import { Logger } from "../util/logging";
import { isExternalModule } from "../util/ts";
import { hasWindowsSlashes, joinPaths, normalizeSlashes, stripQuotes, sort } from "../util/util";

import { readFile } from "./definition-parser";

export default async function getModuleInfo(packageName: string, directory: string, allEntryFilenames: string[], log: Logger): Promise<ModuleInfo> {
	let hasUmdDecl = false;
	let hasGlobalDeclarations = false;
	let ambientModuleCount = 0;

	const dependencies = new Set<string>();
	const declaredModules: string[] = [];
	const globals = new Set<string>();

	const all = await allReferencedFiles(directory, allEntryFilenames, log);

	for (const src of all.values()) {
		const isExternal = isExternalModule(src);
		// A file is a proper module if it is an external module *and* it has at least one export.
		// A module with only imports is not a proper module; it likely just augments some other module.
		let hasAnyExport = false;

		function addDependency(dependency: string): void {
			if (dependency !== packageName) {
				dependencies.add(dependency);
			}
			// TODO: else throw new Error(`Package ${packageName} references itself. (via ${src.fileName})`);
		}

		for (const ref of imports(src)) {
			if (!ref.startsWith(".")) {
				const importedModule = rootName(ref);
				addDependency(importedModule);
				log(`Found import declaration from \`"${importedModule}"\``);
			}
		}

		for (const ref of src.typeReferenceDirectives) {
			addDependency(ref.fileName);
		}

		for (const node of src.statements) {
			switch (node.kind) {
				case ts.SyntaxKind.NamespaceExportDeclaration:
					const globalName = (node as ts.NamespaceExportDeclaration).name.getText();
					log(`Found UMD module declaration for global \`${globalName}\``);
					// Don't set hasGlobalDeclarations = true even though we add a symbol here
					// since this is still a legal module-only declaration
					globals.add(globalName);
					hasAnyExport = true;
					hasUmdDecl = true;
					break;

				case ts.SyntaxKind.ModuleDeclaration:
					if (isExternal) {
						log(`Found exported namespace \`${(node as ts.ModuleDeclaration).name.getText()}\``);
						hasAnyExport = true;
					} else {
						const nameKind = (node as ts.ModuleDeclaration).name.kind;
						if (nameKind === ts.SyntaxKind.StringLiteral) {
							// If we're in an external module, this is an augmentation, not a declaration.
							if (!isExternalModule(src)) {
								const name = stripQuotes((node as ts.ModuleDeclaration).name.getText());
								noWindowsSlashes(packageName, name);

								declaredModules.push(name);
								log(`Found ambient external module \`"${name}"\``);
								ambientModuleCount++;
							}
						} else {
							const moduleName = (node as ts.ModuleDeclaration).name.getText();
							log(`Found global namespace declaration \`${moduleName}\``);
							hasGlobalDeclarations = true;
							if (isValueNamespace(node as ts.ModuleDeclaration)) {
								globals.add(moduleName);
							}
						}
					}
					break;

				case ts.SyntaxKind.VariableStatement:
					if (isExternal) {
						log("Found exported variables");
						hasAnyExport = true;
					} else {
						(node as ts.VariableStatement).declarationList.declarations.forEach(decl => {
							const declName = decl.name.getText();
							log(`Found global variable \`${declName}\``);
							globals.add(declName);
						});
						hasGlobalDeclarations = true;
					}
					break;

				case ts.SyntaxKind.InterfaceDeclaration:
				case ts.SyntaxKind.TypeAliasDeclaration:
				case ts.SyntaxKind.EnumDeclaration:
				case ts.SyntaxKind.ClassDeclaration:
				case ts.SyntaxKind.FunctionDeclaration:
					// If these nodes have an 'export' modifier, the file is an external module
					if (isExternal) {
						const declName = (node as ts.DeclarationStatement).name;
						if (declName) {
							log(`Found exported declaration "${declName.getText()}"`);
						}
						hasAnyExport = true;
					} else {
						const declName = ((node as ts.DeclarationStatement).name as ts.Identifier).getText();
						const isType = node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.TypeAliasDeclaration;
						log(`Found global ${isType ? "type" : "value"} declaration "${declName}"`);
						if (!isType) {
							globals.add(declName);
						}
						hasGlobalDeclarations = true;
					}
					break;

				case ts.SyntaxKind.ExportDeclaration:
				case ts.SyntaxKind.ExportAssignment:
					// These nodes always indicate an external module
					log(`Found export assignment or export declaration`);
					hasAnyExport = true;
					break;

				case ts.SyntaxKind.ImportEqualsDeclaration:
				case ts.SyntaxKind.ImportDeclaration:
					// Already handled these in `imports`
					break;

				default:
					throw new Error(`Bad node in ${joinPaths(directory, src.fileName)}: '${node.getText()}' is of kind ${ts.SyntaxKind[node.kind]}`);
			}
		}

		const isProperModule = isExternal && hasAnyExport;

		if (isProperModule) {
			declaredModules.push(properModuleName(packageName, src.fileName));
		}
	}

	return {
		declFiles: sort(all.keys()),
		dependencies,
		declaredModules,
		globals: sort(globals)
	};
}

interface ModuleInfo {
	// Every declaration file used (starting from the entry point)
	declFiles: string[];
	dependencies: Set<string>;
	// Anything from a `declare module "foo"`
	declaredModules: string[];
	// Every global symbol
	globals: string[];
}

/**
 * Given a file name, get the name of the module it declares.
 * `foo/index.d.ts` declares "foo", `foo/bar.d.ts` declares "foo/bar", "foo/bar/index.d.ts" declares "foo/bar"
 */
function properModuleName(folderName: string, fileName: string): string {
	const part = path.basename(fileName) === "index.d.ts" ? path.dirname(fileName) : withoutExtension(fileName, ".d.ts");
	return joinPaths(folderName, part);
}

/** Given "foo/bar/baz", return "foo". */
function rootName(importText: string) {
	let slash = importText.indexOf("/");
	// Root of `@foo/bar/baz` is `@foo/bar`
	if (importText.startsWith("@")) {
		// Use second "/"
		slash = importText.indexOf("/", slash + 1);
	}
	return slash === -1 ? importText : importText.slice(0, slash);
}

function withoutExtension(str: string, ext: string): string {
	assert(str.endsWith(ext));
	return str.slice(0, str.length - ext.length);
}

/** Returns a map from filename (path relative to `directory`) to the SourceFile we parsed for it. */
async function allReferencedFiles(directory: string, entryFilenames: string[], log: Logger): Promise<Map<string, ts.SourceFile>> {
	const seenReferences = new Set<string>();
	const all = new Map<string, ts.SourceFile>();

	async function recur(referencedFrom: string, { text, exact }: Reference): Promise<void> {
		if (seenReferences.has(text)) {
			return;
		}
		seenReferences.add(text);

		const { resolvedFilename, content } = exact
			? { resolvedFilename: text, content: await readFileAndReportErrors(referencedFrom, directory, text, text) }
			: await resolveModule(referencedFrom, directory, text);
		log(`Parse ${resolvedFilename}`);
		const src = ts.createSourceFile(resolvedFilename, content, ts.ScriptTarget.Latest, true);
		all.set(resolvedFilename, src);

		const refs = referencedFiles(src, path.dirname(resolvedFilename), directory);
		await Promise.all(Array.from(refs).map(ref => recur(resolvedFilename, ref)));
	}

	await Promise.all(entryFilenames.map(filename => recur("tsconfig.json", { text: filename, exact: true })));
	return all;
}

async function resolveModule(referencedFrom: string, directory: string, filename: string): Promise<{ resolvedFilename: string, content: string }> {
	try {
		const dts = filename + ".d.ts";
		return { resolvedFilename: dts, content: await readFile(directory, dts) };
	} catch (_) {
		const index = joinPaths(filename, "index.d.ts");
		return { resolvedFilename: index, content: await readFileAndReportErrors(referencedFrom, directory, filename, index) };
	}
}

async function readFileAndReportErrors(referencedFrom: string, directory: string, referenceText: string, filename: string): Promise<string> {
	try {
		return await readFile(directory, filename);
	} catch (err) {
		console.error(`In ${directory}, ${referencedFrom} references ${referenceText}, which can't be read.`);
		throw err;
	}
}

interface Reference {
	/** <reference path> includes exact filename, so true. import "foo" may reference "foo.d.ts" or "foo/index.d.ts", so false. */
	exact: boolean;
	text: string;
}

/**
 * @param subDirectory The specific directory within the DefinitelyTyped directory we are in.
 * For example, `directory` may be `react-router` and `subDirectory` may be `react-router/lib`.
 */
function* referencedFiles(src: ts.SourceFile, subDirectory: string, directory: string): Iterable<Reference> {
	const out: Reference[] = [];

	for (const ref of src.referencedFiles) {
		// Any <reference path="foo"> is assumed to be local
		yield addReference({ text: ref.fileName, exact: true });
	}

	for (const ref of imports(src)) {
		if (ref.startsWith(".")) {
			yield addReference({ text: ref, exact: false });
		}
	}

	return out;

	function addReference({ exact, text }: Reference): Reference {
		noWindowsSlashes(src.fileName, text);
		let full = path.normalize(joinPaths(subDirectory, text));
		// `path.normalize` may add windows slashes
		full = normalizeSlashes(full);
		if (full.startsWith(".")) {
			throw new Error(
				`In ${directory} ${src.fileName}: Definitions must use global references, not parent references. (Based on reference '${text}')`);
		}
		return { exact, text: full };
	}
}

/**
 * All strings referenced in `import` statements.
 * Does *not* include <reference> directives.
 */
function imports(src: ts.SourceFile): string[] {
	const out: string[] = [];
	findImports(src.statements);
	return out;

	function findImports(statements: ts.Statement[]) {
		for (const node of statements) {
			switch (node.kind) {
				case ts.SyntaxKind.ImportDeclaration:
				case ts.SyntaxKind.ExportDeclaration: {
					const decl = node as ts.ImportDeclaration | ts.ExportDeclaration;
					if (decl.moduleSpecifier && decl.moduleSpecifier.kind === ts.SyntaxKind.StringLiteral) {
						out.push(stripQuotes(decl.moduleSpecifier.getText()));
					}
					break;
				}

				case ts.SyntaxKind.ImportEqualsDeclaration: {
					const decl = node as ts.ImportEqualsDeclaration;
					if (decl.moduleReference.kind === ts.SyntaxKind.ExternalModuleReference) {
						out.push(parseRequire(decl.moduleReference));
					}
					break;
				}

				case ts.SyntaxKind.ModuleDeclaration: {
					const decl = node as ts.ModuleDeclaration;
					if (decl.name.kind === ts.SyntaxKind.StringLiteral) {
						findImports((decl.body as ts.ModuleBlock).statements);
					}
					break;
				}

				default:
			}
		}
	}

	function parseRequire(reference: ts.ExternalModuleReference): string {
		const expr = reference.expression;
		if (!expr || expr.kind !== ts.SyntaxKind.StringLiteral) {
			throw new Error(`Bad 'import =' reference: ${reference.getText()}`);
		}
		return (expr as ts.StringLiteral).text;
	}
}

function isValueNamespace(ns: ts.ModuleDeclaration): boolean {
	if (!ns.body) {
		throw new Error("@types should not use shorthand ambient modules");
	}
	if (ns.body.kind === ts.SyntaxKind.ModuleDeclaration) {
		return isValueNamespace(ns.body as ts.ModuleDeclaration);
	}
	return (ns.body as ts.ModuleBlock).statements.some(statementDeclaresValue);
}

function statementDeclaresValue(statement: ts.Statement): boolean {
	switch (statement.kind) {
		case ts.SyntaxKind.VariableStatement:
		case ts.SyntaxKind.ClassDeclaration:
		case ts.SyntaxKind.FunctionDeclaration:
		case ts.SyntaxKind.EnumDeclaration:
			return true;

		case ts.SyntaxKind.ModuleDeclaration:
			return isValueNamespace(statement as ts.ModuleDeclaration);

		case ts.SyntaxKind.InterfaceDeclaration:
		case ts.SyntaxKind.TypeAliasDeclaration:
		case ts.SyntaxKind.ImportEqualsDeclaration:
			return false;

		default:
			throw new Error(`Forgot to implement ambient namespace statement ${ts.SyntaxKind[statement.kind]}`);
	}
}

function noWindowsSlashes(packageName: string, fileName: string): void {
	if (hasWindowsSlashes(fileName)) {
		throw new Error(`In ${packageName}: Use forward slash instead when referencing ${fileName}`);
	}
}