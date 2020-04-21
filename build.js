const fs = require('fs')
const path = require('path')
const htmlMinifier = require('html-minifier').minify
const uglifyJS = require('uglify-js')
const zlib = require('zlib')
const rip = require('./styleripper')

const PROD = process.env.PRODUCTION == 'true'

const ComponentRegex = /<%(.+)%>/g

let HtmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<%head%>
</head>
<body>
<div id="root"> <%body%> </div>
<%navigation%>
</body>
</html>`

const NavigationTemplate = `var root = document.querySelector('#root')
function d() {
  document.querySelectorAll('a[href]').forEach(function(e) { e.onclick = g })
}
function g(e) {
  var p = typeof e == 'object' ? e.target.getAttribute('href') : e
  root.innerHTML = r[p]
  history.pushState({}, '', p)
  d()
  return false
}
window.onpopstate = function() {
  g(location.pathname)
}
d()
<%routes%>
r[location.pathname] = root.innerHTML`

function build() {
	// Read head.html
	const headbuf = fs.readFileSync('head.html')
	HtmlTemplate = HtmlTemplate.replace('<%head%>', headbuf.toString())

	// Gather the files we need to process
	let files = collect('./pages', ['.html', '.css']).concat(collect('./styles', ['.css']))
		.map(f => { return { path: f, data: fs.readFileSync(f, 'utf8') } })

	let htmlFiles = files.filter(f => f.path.endsWith('.html'))
	let cssFiles = files.filter(f => f.path.endsWith('.css'))

	htmlFiles.forEach(page => {
		// Match each component name, specified like "<%component%>"
		let m = []
		while (m = ComponentRegex.exec(page.data)) {
			const compTempl = m[0]
			const re = new RegExp(compTempl, 'g')
			const comp = m[1]
			const compData = fs.readFileSync(`./components/${comp}/index.html`, 'utf8')

			page.data = page.data.replace(re, compData)
		}
	})

	// Use Styleripper to uglify HTML and CSS
	if (PROD) {
		const ripped = rip(htmlFiles, cssFiles)
		htmlFiles = ripped.htmlFiles
		cssFiles = ripped.cssFiles
	}

	let routes = {}
	for (const page of htmlFiles) {
		let data = page.data
		if (PROD) {
			data = minifyHTML(page.data)
		}
		routes[pathToRoute(page.path)] = data
	}

	// Remove "dist" dir
	fs.rmdirSync('./dist', { recursive: true })

	// Create all output directories
	walk('./pages', [], (filepath, isDir) => {
		if (isDir) {
			fs.mkdirSync(`./dist/${removeFirstDir(filepath)}`, { recursive: true })
		}
	})

	for (const page of htmlFiles) {
		// Append routes except self to navigation template, and close the script tag
		let selfRoutes = Object.assign({}, routes)
		delete (selfRoutes[pathToRoute(page.path)])
		selfRoutes = JSON.stringify(selfRoutes)

		let navigation = NavigationTemplate.replace('<%routes%>', `var r = ${selfRoutes}`)
		if (PROD) {
			navigation = uglifyJS.minify(navigation).code
		}

		let template = HtmlTemplate.replace('<%navigation%>', `<script>${navigation}</script>`)
		template = template.replace('<%body%>', page.data)

		if (PROD) {
			template = minifyHTML(template)
		}

		// Write HTML to file
		writeFile(`./dist/${removeFirstDir(page.path)}`, template)
	}

	// Write concatted CSS files
	const concattedCSS = cssFiles.reduce((acc, f) => f.data + acc, '')
	writeFile(`./dist/built.css`, concattedCSS)
}

function watch(fn) {
	let wtimeout
	const debounce = () => {
		if (!wtimeout) {
			fn()
			wtimeout = setTimeout(() => { wtimeout = null }, 200)
		}
	}
	// Debounce
	const files = collect('./', ['.html', '.css'], ['node_modules', 'dist'])
	for (const f of files) {
		fs.watch(f, {}, debounce)
	}
}

module.exports = {
	build,
	watch,
}

// Call function on every file
function walk(d, exclude, fn) {
	const dir = fs.opendirSync(d)

	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = path.join(d, dirent.name)
		if (dirent.isDirectory()) {
			let ok = true
			for (const excl of exclude) {
				if (full.endsWith(excl)) {
					ok = false
					break
				}
			}
			if (!ok) {
				continue
			}

			fn(full, true) // is dir
			walk(full, exclude, fn)
		} else {
			fn(full, false) // is not dir
		}
	}
	dir.closeSync()
}

function collect(path, extensions, exclude) {
	exclude = exclude || []
	let files = []
	walk(path, exclude, (filepath, isDir) => {
		if (isDir) {
			return
		}

		let ok = false
		for (const ext of extensions) {
			if (filepath.endsWith(ext)) {
				ok = true
				break
			}
		}
		if (!ok) {
			return
		}

		if (exclude && exclude.length > 0) {
			let ok = true
			for (const exc of exclude) {
				if (filepath.endsWith(exc)) {
					ok = false
					break
				}
			}
			if (!ok) {
				return
			}
		}

		files.push(filepath)
	})
	return files
}

function minifyHTML(data) {
	return htmlMinifier(data, {
		collapseWhitespace: true,
		removeAttributeQuotes: true,
		removeComments: true,
	})
}

function writeFile(path, data) {
	if (PROD) {
		fs.writeFileSync(`${path}.br`, zlib.brotliCompressSync(data))
		return
	}

	fs.writeFileSync(path, data)
}

function removeFirstDir(p) {
	return p.replace(/.+?\//, '')
}

function pathToRoute(p) {
	return `/${removeFirstDir(p).replace(/index\.html$/, '')}`
}