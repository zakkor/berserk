const fs = require('fs')
const csstree = require('css-tree')
const htmlparse = require('node-html-parser')

// Takes a list of .html and .css files.
// Ordering does not matter, but file extension does.
function rip(files) {
	const htmlFiles = readFiles(files, '.html')
	const cssFiles = readFiles(files, '.css')

	// classnames contains information about the class name nodes appearing in all input files.
	// `count` is the number of times each class name appears, created first when parsing HTML
	// and updated when parsing CSS.
	// `total` is the number of bytes occupied by this classname in both HTML and CSS files, created only after parsing CSS.
	const classnames = {}
	// renames contains information describing which nodes to rename to what
	const rename = {
		classnames: {} // { 'from': 'to' }
	}

	// Iterate through all HTML files and parse their contents,
	// collecting information about different node types.
	htmlFiles.forEach(f => {
		f.ast = parseHTML(classnames, f.data)
	})

	// Iterate through all CSS files and parse their contents,
	// collecting more information about different node types.
	// Before walking the AST, all unused classnames are removed.
	cssFiles.forEach(f => {
		f.ast = parseCSS(classnames, f.data)
	})

	// Calculate the total byte size of each classname (count * name length) and collect it into an array so we can sort it.
	let sorted = Object.entries(classnames)
		.map(([name, sel]) => {
			return { name, total: name.length * sel.count }
		}).sort((a, b) => b.total - a.total)

	// Afterwards, nodes are renamed and recorded in `rename`, and the resulting CSS is returned.
	// Concatenate results into a string of all CSS file contents.
	const css = {
		path: 'built.css',
		data: cssFiles.map(f => processCSS(sorted, rename, f.ast)).reduce((x, acc) => x + acc, ''),
	}

	// Go through HTML files again, and rewrite all nodes according to `rename`.
	// Gather each file's rewritten content in an array.
	const html = htmlFiles.map(f => {
		processHTMLNodeChildren(rename, f.ast)
		return {
			path: f.name,
			data: f.ast.toString(),
		}
	})

	return {
		html,
		css,
	}
}

module.exports = rip

function readFiles(files, extension) {
	return files.filter(f => f.endsWith(extension)).map(f => { return { name: f, data: fs.readFileSync(f, 'utf8') } })
}

function parseCSS(classnames, data) {
	// Parse given CSS file into an AST.
	const ast = csstree.parse(data)

	// Walk AST and remove rules in which the only selector is an unused class.
	csstree.walk(ast, {
		visit: 'Rule',
		enter: function (node, parentItem, parentList) {
			node.prelude.children.each((selector, item, list) => {
				// Remove any unused class selectors from SelectorList
				selector.children.each((s) => {
					if (s.type !== 'ClassSelector' || cleanCSSIdentifier(s.name) in classnames) {
						return
					}

					list.remove(item)
				})

				// We've removed all the selectors, need to remove entire rule.
				if (list.isEmpty()) {
					parentList.remove(parentItem)
				}
			})
		}
	})

	// Walk through all class selectors and increment their count.
	// (Only if they are used, as we have already removed all unused classnames)
	csstree.walk(ast, {
		visit: 'ClassSelector',
		enter: function (node) {
			const name = cleanCSSIdentifier(node.name)
			if (!(name in classnames)) {
				throw new Error('encountered unused class selector when it should have been removed')
			}

			classnames[name].count++
		}
	})

	return ast
}

function processCSS(sorted, rename, ast) {
	// For each selector in sorted order, walk through AST and rename each occurrence.
	for (const [i, sel] of sorted.entries()) {
		csstree.walk(ast, {
			visit: 'ClassSelector',
			enter: function (node) {
				const name = cleanCSSIdentifier(node.name)
				if (name !== sel.name) {
					return
				}

				const newname = generateShortestName(i)
				rename[name] = newname
				node.name = newname
			}
		})
	}

	return csstree.generate(ast)
}

function cleanCSSIdentifier(n) {
	return n.replace(/\\/g, '')
}

function parseHTML(classnames, data) {
	const ast = htmlparse.parse(data)
	parseHTMLNodeChildren(classnames, ast)
	return ast
}

function parseHTMLNodeChildren(classnames, node) {
	// Count each className occurrence.
	if (node.classNames) {
		for (const className of node.classNames) {
			if (className in classnames) {
				classnames[className].count++
				continue
			}
			classnames[className] = { count: 1 }
		}
	}

	for (const child of node.childNodes) {
		parseHTMLNodeChildren(classnames, child)
	}
}

function processHTMLNodeChildren(rename, node) {
	if (node.classNames) {
		const replace = node.classNames.map(c => {
			if (c in rename) {
				return rename[c]
			}

			return c
		})

		if (replace.length > 0) {
			node.setAttribute('class', replace.join(' '))
		}
	}

	for (const child of node.childNodes) {
		processHTMLNodeChildren(rename, child)
	}
}

function generateShortestName(idx) {
	function range(s, e) {
		let a = []
		for (let i = s; i < e; i++) {
			a.push(i)
		}
		return a
	}

	// fill with a-z
	const ascii = range(97, 123).map(c => String.fromCharCode(c))

	let timesOver = 0
	while (idx >= ascii.length) {
		timesOver++

		idx -= ascii.length
	}

	if (timesOver) {
		return ascii[idx] + (timesOver - 1)
	}

	return ascii[idx]
}