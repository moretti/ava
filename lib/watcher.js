'use strict';
var nodePath = require('path');
var debug = require('debug')('ava:watcher');
var diff = require('arr-diff');
var flatten = require('arr-flatten');
var union = require('array-union');
var uniq = require('array-uniq');
var defaultIgnore = require('ignore-by-default').directories();
var multimatch = require('multimatch');
var slash = require('slash');
var AvaError = require('./ava-error');
var AvaFiles = require('./ava-files');

function requireChokidar() {
	try {
		return require('chokidar');
	} catch (err) {
		throw new AvaError('The optional dependency chokidar failed to install and is required for --watch. Chokidar is likely not supported on your platform.');
	}
}

function rethrowAsync(err) {
	// Don't swallow exceptions. Note that any expected error should already have
	// been logged.
	setImmediate(function () {
		throw err;
	});
}

function getDefaultIgnorePatterns() {
	return defaultIgnore.map(function (dir) {
		return dir + '/**/*';
	});
}

// Used on paths before they're passed to multimatch to Harmonize matching
// across platforms.
var matchable = process.platform === 'win32' ? slash : function (path) {
	return path;
};

function Watcher(logger, api, files, sources) {
	this.debouncer = new Debouncer(this);

	this.isTest = makeTestMatcher(files, AvaFiles.defaultExcludePatterns());

	this.clearLogOnNextRun = true;
	this.runVector = 0;
	this.run = function (specificFiles) {
		if (this.runVector > 0) {
			var cleared = this.clearLogOnNextRun && logger.clear();
			if (!cleared) {
				logger.reset();
				logger.section();
			}
			this.clearLogOnNextRun = true;

			logger.reset();
			logger.start();
		}

		var currentVector = this.runVector += 1;

		var runOnlyExclusive = false;

		if (specificFiles) {
			var exclusiveFiles = specificFiles.filter(function (file) {
				return this.filesWithExclusiveTests.indexOf(file) !== -1;
			}, this);

			runOnlyExclusive = exclusiveFiles.length !== this.filesWithExclusiveTests.length;

			if (runOnlyExclusive) {
				// The test files that previously contained exclusive tests are always
				// run, together with the remaining specific files.
				var remainingFiles = diff(specificFiles, exclusiveFiles);
				specificFiles = this.filesWithExclusiveTests.concat(remainingFiles);
			}
		}

		var self = this;
		this.busy = api.run(specificFiles || files, {
			runOnlyExclusive: runOnlyExclusive
		}).then(function (runStatus) {
			runStatus.previousFailCount = self.sumPreviousFailures(currentVector);
			logger.finish(runStatus);

			var badCounts = runStatus.failCount + runStatus.rejectionCount + runStatus.exceptionCount;
			self.clearLogOnNextRun = self.clearLogOnNextRun && badCounts === 0;
		}, rethrowAsync);
	};

	this.testDependencies = [];
	this.trackTestDependencies(api, sources);

	this.filesWithExclusiveTests = [];
	this.trackExclusivity(api);

	this.filesWithFailures = [];
	this.trackFailures(api);

	this.dirtyStates = {};
	this.watchFiles(files, sources);
	this.rerunAll();
}

module.exports = Watcher;

Watcher.prototype.watchFiles = function (files, sources) {
	var self = this;
	var patterns = getChokidarPatterns(files, sources);

	requireChokidar().watch(patterns.paths, {
		ignored: patterns.ignored,
		ignoreInitial: true
	}).on('all', function (event, path) {
		if (event === 'add' || event === 'change' || event === 'unlink') {
			debug('Detected %s of %s', event, path);
			self.dirtyStates[path] = event;
			self.debouncer.debounce();
		}
	});
};

Watcher.prototype.trackTestDependencies = function (api, sources) {
	var self = this;
	var isSource = makeSourceMatcher(sources);
	var relative = function (absPath) {
		return nodePath.relative('.', absPath);
	};

	api.on('test-run', function (runStatus) {
		runStatus.on('dependencies', function (file, dependencies) {
			var sourceDeps = dependencies.map(relative).filter(isSource);
			self.updateTestDependencies(file, sourceDeps);
		});
	});
};

Watcher.prototype.updateTestDependencies = function (file, sources) {
	if (sources.length === 0) {
		this.testDependencies = this.testDependencies.filter(function (dep) {
			return dep.file !== file;
		});

		return;
	}

	var isUpdate = this.testDependencies.some(function (dep) {
		if (dep.file !== file) {
			return false;
		}

		dep.sources = sources;

		return true;
	});

	if (!isUpdate) {
		this.testDependencies.push(new TestDependency(file, sources));
	}
};

Watcher.prototype.trackExclusivity = function (api) {
	var self = this;

	api.on('stats', function (stats) {
		self.updateExclusivity(stats.file, stats.hasExclusive);
	});
};

Watcher.prototype.updateExclusivity = function (file, hasExclusiveTests) {
	var index = this.filesWithExclusiveTests.indexOf(file);

	if (hasExclusiveTests && index === -1) {
		this.filesWithExclusiveTests.push(file);
	} else if (!hasExclusiveTests && index !== -1) {
		this.filesWithExclusiveTests.splice(index, 1);
	}
};

Watcher.prototype.trackFailures = function (api) {
	var self = this;

	api.on('test-run', function (runStatus, files) {
		files.forEach(function (file) {
			self.pruneFailures(nodePath.relative('.', file));
		});

		var currentVector = self.runVector;
		runStatus.on('error', function (err) {
			self.countFailure(err.file, currentVector);
		});
		runStatus.on('test', function (result) {
			if (result.error) {
				self.countFailure(result.file, currentVector);
			}
		});
	});
};

Watcher.prototype.pruneFailures = function (file) {
	this.filesWithFailures = this.filesWithFailures.filter(function (state) {
		return state.file !== file;
	});
};

Watcher.prototype.countFailure = function (file, vector) {
	var isUpdate = this.filesWithFailures.some(function (state) {
		if (state.file !== file) {
			return false;
		}

		state.count++;
		return true;
	});

	if (!isUpdate) {
		this.filesWithFailures.push({
			file: file,
			vector: vector,
			count: 1
		});
	}
};

Watcher.prototype.sumPreviousFailures = function (beforeVector) {
	var total = 0;

	this.filesWithFailures.forEach(function (state) {
		if (state.vector < beforeVector) {
			total += state.count;
		}
	});

	return total;
};

Watcher.prototype.cleanUnlinkedTests = function (unlinkedTests) {
	unlinkedTests.forEach(function (testFile) {
		this.updateTestDependencies(testFile, []);
		this.updateExclusivity(testFile, false);
		this.pruneFailures(testFile);
	}, this);
};

Watcher.prototype.observeStdin = function (stdin) {
	var self = this;

	stdin.resume();
	stdin.setEncoding('utf8');

	stdin.on('data', function (data) {
		data = data.trim().toLowerCase();
		if (data !== 'r' && data !== 'rs') {
			return;
		}

		// Cancel the debouncer, it might rerun specific tests whereas *all* tests
		// need to be rerun.
		self.debouncer.cancel();
		self.busy.then(function () {
			// Cancel the debouncer again, it might have restarted while waiting for
			// the busy promise to fulfil.
			self.debouncer.cancel();
			self.clearLogOnNextRun = false;
			self.rerunAll();
		});
	});
};

Watcher.prototype.rerunAll = function () {
	this.dirtyStates = {};
	this.run();
};

Watcher.prototype.runAfterChanges = function () {
	var dirtyStates = this.dirtyStates;
	this.dirtyStates = {};

	var dirtyPaths = Object.keys(dirtyStates);
	var dirtyTests = dirtyPaths.filter(this.isTest);
	var dirtySources = diff(dirtyPaths, dirtyTests);
	var addedOrChangedTests = dirtyTests.filter(function (path) {
		return dirtyStates[path] !== 'unlink';
	});
	var unlinkedTests = diff(dirtyTests, addedOrChangedTests);

	this.cleanUnlinkedTests(unlinkedTests);
	// No need to rerun tests if the only change is that tests were deleted.
	if (unlinkedTests.length === dirtyPaths.length) {
		return;
	}

	if (dirtySources.length === 0) {
		// Run any new or changed tests.
		this.run(addedOrChangedTests);
		return;
	}

	// Try to find tests that depend on the changed source files.
	var testsBySource = dirtySources.map(function (path) {
		return this.testDependencies.filter(function (dep) {
			return dep.contains(path);
		}).map(function (dep) {
			debug('%s is a dependency of %s', path, dep.file);
			return dep.file;
		});
	}, this).filter(function (tests) {
		return tests.length > 0;
	});

	// Rerun all tests if source files were changed that could not be traced to
	// specific tests.
	if (testsBySource.length !== dirtySources.length) {
		debug('Sources remain that cannot be traced to specific tests. Rerunning all tests');
		this.run();
		return;
	}

	// Run all affected tests.
	this.run(union(addedOrChangedTests, uniq(flatten(testsBySource))));
};

function Debouncer(watcher) {
	this.watcher = watcher;
	this.timer = null;
	this.repeat = false;
}

Debouncer.prototype.debounce = function () {
	if (this.timer) {
		this.again = true;
		return;
	}

	var self = this;

	var timer = this.timer = setTimeout(function () {
		self.watcher.busy.then(function () {
			// Do nothing if debouncing was canceled while waiting for the busy
			// promise to fulfil.
			if (self.timer !== timer) {
				return;
			}

			if (self.again) {
				self.timer = null;
				self.again = false;
				self.debounce();
			} else {
				self.watcher.runAfterChanges();
				self.timer = null;
				self.again = false;
			}
		});
	}, 10);
};

Debouncer.prototype.cancel = function () {
	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = null;
		this.again = false;
	}
};

function getChokidarPatterns(files, sources) {
	var paths = [];
	var ignored = [];

	sources.forEach(function (pattern) {
		if (pattern[0] === '!') {
			ignored.push(pattern.slice(1));
		} else {
			paths.push(pattern);
		}
	});

	// Allow source patterns to override the default ignore patterns. Chokidar
	// ignores paths that match the list of ignored patterns. It uses anymatch
	// under the hood, which supports negation patterns. For any source pattern
	// that starts with an ignored directory, ensure the corresponding negation
	// pattern is added to the ignored paths.
	var overrideDefaultIgnorePatterns = paths.filter(function (pattern) {
		return defaultIgnore.indexOf(pattern.split('/')[0]) >= 0;
	}).map(function (pattern) {
		return '!' + pattern;
	});
	ignored = getDefaultIgnorePatterns().concat(ignored, overrideDefaultIgnorePatterns);

	if (paths.length === 0) {
		paths = ['package.json', '**/*.js'];
	}
	paths = paths.concat(files);

	return {
		paths: paths,
		ignored: ignored
	};
}

function makeSourceMatcher(sources) {
	var mixedPatterns = [];
	var defaultIgnorePatterns = getDefaultIgnorePatterns();
	var overrideDefaultIgnorePatterns = [];

	var hasPositivePattern = false;
	sources.forEach(function (pattern) {
		mixedPatterns.push(pattern);
		if (!hasPositivePattern && pattern[0] !== '!') {
			hasPositivePattern = true;
		}

		// Extract patterns that start with an ignored directory. These need to be
		// rematched separately.
		if (defaultIgnore.indexOf(pattern.split('/')[0]) >= 0) {
			overrideDefaultIgnorePatterns.push(pattern);
		}
	});

	// Same defaults as used for Chokidar.
	if (!hasPositivePattern) {
		mixedPatterns = ['package.json', '**/*.js'].concat(mixedPatterns);
	}

	return function (path) {
		path = matchable(path);

		// Ignore paths outside the current working directory. They can't be matched
		// to a pattern.
		if (/^\.\.\//.test(path)) {
			return false;
		}

		var isSource = multimatch(path, mixedPatterns).length === 1;
		if (!isSource) {
			return false;
		}

		var isIgnored = multimatch(path, defaultIgnorePatterns).length === 1;
		if (!isIgnored) {
			return true;
		}

		var isErroneouslyIgnored = multimatch(path, overrideDefaultIgnorePatterns).length === 1;
		if (isErroneouslyIgnored) {
			return true;
		}

		return false;
	};
}

function makeTestMatcher(files, excludePatterns) {
	var initialPatterns = files.concat(excludePatterns);

	return function (path) {
		// Like in api.js, tests must be .js files and not start with _
		if (nodePath.extname(path) !== '.js' || nodePath.basename(path)[0] === '_') {
			return false;
		}

		// Check if the entire path matches a pattern.
		if (multimatch(matchable(path), initialPatterns).length === 1) {
			return true;
		}

		// Check if the path contains any directory components.
		var dirname = nodePath.dirname(path);
		if (dirname === '.') {
			return false;
		}

		// Compute all possible subpaths. Note that the dirname is assumed to be
		// relative to the working directory, without a leading `./`.
		var subpaths = dirname.split(nodePath.sep).reduce(function (subpaths, component) {
			var parent = subpaths[subpaths.length - 1];
			if (parent) {
				// Always use / to makes multimatch consistent across platforms.
				subpaths.push(parent + '/' + component);
			} else {
				subpaths.push(component);
			}
			return subpaths;
		}, []);

		// Check if any of the possible subpaths match a pattern. If so, generate a
		// new pattern with **/*.js.
		var recursivePatterns = subpaths.filter(function (subpath) {
			return multimatch(subpath, initialPatterns).length === 1;
		}).map(function (subpath) {
			// Always use / to makes multimatch consistent across platforms.
			return subpath + '/**/*.js';
		});

		// See if the entire path matches any of the subpaths patterns, taking the
		// excludePatterns into account. This mimicks the behavior in api.js
		return multimatch(matchable(path), recursivePatterns.concat(excludePatterns)).length === 1;
	};
}

function TestDependency(file, sources) {
	this.file = file;
	this.sources = sources;
}

TestDependency.prototype.contains = function (source) {
	return this.sources.indexOf(source) !== -1;
};
