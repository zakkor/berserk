const fs = require('fs')
const filepath = require('path')
const htmlMinifier = require('html-minifier').minify
const uglifyJS = require('uglify-js')
const zlib = require('zlib')
const rip = require('./styleripper')

const ComponentRegex = /<%(.+)%>/g

let HtmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<%head%>
</head>
<body>
<div id="root">
<%root%>
</div>
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

function build({ prod }) {
	// Read head.html
	const head = fs.readFileSync('head.html', 'utf8')
	HtmlTemplate = HtmlTemplate.replace('<%head%>', head)

	// Gather the files we need to process
	let files = collect('./pages', ['.html', '.css', '.js']).concat(collect('./styles', ['.css']))
		.map(f => { return { path: f, data: fs.readFileSync(f, 'utf8') } })

	const keep = ext => {
		return (f) => f.path.endsWith(ext)
	}
	let htmlFiles = files.filter(keep('.html'))
	let cssFiles = files.filter(keep('.css'))
	let jsFiles = files.filter(keep('.js'))

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
	if (prod) {
		const ripped = rip(htmlFiles, cssFiles)
		htmlFiles = ripped.htmlFiles
		cssFiles = ripped.cssFiles
	}

	let routes = {}
	for (const page of htmlFiles) {
		let data = page.data
		if (prod) {
			data = minifyHTML(page.data)
		}
		routes[pathToRoute(page.path)] = data
	}

	// Ignore error if already exists
	fs.mkdirSync('./dist', { recursive: true })

	// Remove "dist" dir
	walkToplevel('./dist', (path, isDir) => {
		if (isDir) {
			fs.rmdirSync(path, { recursive: true })
			return
		}

		fs.unlinkSync(path)
	})

	// Create all output directories
	walk('./pages', [], (path, isDir) => {
		if (isDir) {
			fs.mkdirSync(`./dist/${removeFirstDir(path)}`, { recursive: true })
		}
	})

	for (const page of htmlFiles) {
		// Append routes except self to navigation template, and close the script tag
		let selfRoutes = Object.assign({}, routes)
		delete (selfRoutes[pathToRoute(page.path)])
		selfRoutes = JSON.stringify(selfRoutes)

		let navigation = NavigationTemplate.replace('<%routes%>', `var r = ${selfRoutes}`)
		if (prod) {
			navigation = uglifyJS.minify(navigation).code
		}

		let template = HtmlTemplate.replace('<%navigation%>', `<script>${navigation}</script>`)
		template = template.replace('<%root%>', page.data)

		if (prod) {
			template = minifyHTML(template)
		}

		// Write HTML to file
		writeFile(`./dist/${removeFirstDir(page.path)}`, template, prod)
	}

	// Write concatted CSS files
	const cssBundle = concatFiles(cssFiles)
	writeFile('./dist/bundle.css', cssBundle, prod)

	// Uglify JS, concat to bundle.js, and write to file.
	if (prod) {
		for (const f of jsFiles) {
			f.data = uglifyJS.minify(f.data).code
		}
	}
	const jsBundle = concatFiles(jsFiles)
	writeFile('./dist/bundle.js', jsBundle, prod)
}

function watch(fn) {
	const watcher = (file) => {
		let wtimeout
		// Debounce
		return () => {
			if (!wtimeout) {
				// If we don't wait a bit before running the function, some files may not be fully written
				setTimeout(() => {
					fn(file)
				}, 100)
				wtimeout = setTimeout(() => { wtimeout = null }, 200)
			}
		}
	}

	const files = collect('./', ['.html', '.css', '.js'], ['node_modules', 'dist'])
	for (const f of files) {
		fs.watch(f, {}, watcher(f))
	}
}

module.exports = {
	build,
	watch,
}

// Call function on every file
function walk(path, exclude, fn) {
	const dir = fs.opendirSync(path)

	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
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

			walk(full, exclude, fn)
			fn(full, true) // is dir
		} else {
			fn(full, false) // is not dir
		}
	}
	dir.closeSync()
}

function walkToplevel(path, fn) {
	const dir = fs.opendirSync(path)
	let dirent = null
	while (dirent = dir.readSync()) {
		if (dirent === null) {
			break
		}

		const full = filepath.join(path, dirent.name)
		fn(full, dirent.isDirectory())
	}
	dir.closeSync()
}

function collect(path, extensions, exclude) {
	exclude = exclude || []
	let files = []
	walk(path, exclude, (path, isDir) => {
		if (isDir) {
			return
		}

		let ok = false
		for (const ext of extensions) {
			if (path.endsWith(ext)) {
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
				if (path.endsWith(exc)) {
					ok = false
					break
				}
			}
			if (!ok) {
				return
			}
		}

		files.push(path)
	})
	return files
}

function minifyHTML(data) {
	return htmlMinifier(data, {
		collapseWhitespace: true,
		removeAttributeQuotes: true,
		removeComments: true,
		processScripts: true,
		minifyJS: true,
	})
}

function writeFile(path, data, prod) {
	if (prod) {
		fs.writeFileSync(`${path}.br`, zlib.brotliCompressSync(data))
		return
	}

	fs.writeFileSync(path, data)
}

function concatFiles(files) {
	return files.reduce((acc, f) => f.data + acc, '')
}

function removeFirstDir(p) {
	return p.replace(/.+?\//, '')
}

function pathToRoute(p) {
	return `/${removeFirstDir(p).replace(/index\.html$/, '')}`
}