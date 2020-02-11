define (['../util/binarysearch', '../util/interval', '../util/eventify'],
	function (BinarySearch, Interval, eventify) {

	'use strict';

	/*
		UTILITY
	*/

	function isIterable(obj) {
	 	// checks for null and undefined
		if (obj == null) {
		    return false;
		}
		return typeof obj[Symbol.iterator] === 'function';
	}

	/*
		concat two arrays without creating a copy
		push elements from the shortest into the longest
		return the longest
		- does not preserve ordering
	*/
	const mergeArrays = function(arr1, arr2) {
		const [shortest, longest] = (arr1.length <= arr2.length) ? [arr1, arr2] : [arr2, arr1];
		let len = shortest.length;
		for (let i=0; i<len; i++) {
			longest.push(shortest[i]);
		}
		return longest;
	};


	/*
		Add cue to array
		- does not add if cue already exists
		- returns array length
	*/
	var addCueToArray = function (arr, cue) {
		// cue equality defined by key property
		if (arr.length == 0) {
			arr.push(cue);
		} else {
			let idx = arr.findIndex(function (_cue) {
				return _cue.key == cue.key;
			});
			if (idx == -1) {
				arr.push(cue);
			}
		}
		return arr.length;
	};

	/*
		Remove cue from array
		- noop if cue does not exist
		- returns array length
	*/
	var removeCueFromArray = function (arr, cue) {
		// cue equality defined by key property
		if (arr.length == 0) {
			return true;
		} else {
			let idx = arr.findIndex(function (_cue) {
				return _cue.key == cue.key;
			});
			if (idx > -1) {
				arr.splice(idx, 1);
			}
			return arr.length == 0;
		}
	};

    /*
		Setup for cue buckets.
    */
    const CueBucketIds = [0, 10, 100, 1000, 10000, 100000, Infinity];
    var getCueBucketId = function (length) {
    	for (let i=0; i<CueBucketIds.length; i++) {
    		if (length <= CueBucketIds[i]) {
    			return CueBucketIds[i];
    		}
    	}
    };


    /*
		Semantic

		Specifies the semantic for cue operations

		INSIDE  - all cues with both endpoints INSIDE the search interval
		PARTIAL - all INSIDE cues, plus cues that PARTIALL overlap search interval, i.e. have only one endpoint INSIDE search interval
		OVERLAP - all PARTIAL cues, plus cues that fully OVERLAP search interval, but have no endpoints INSIDE search interval

    */
    const Semantic = Object.freeze({
    	INSIDE: "inside",
    	PARTIAL: "partial",
    	OVERLAP: "overlap"
    });


    /*
		Method

		Specifies various methods on CueBuckets

		LOOKUP_CUEPOINTS - look up all (point, cue) tuples in search interval
		LOOKUP_CUES - lookup all cues in interval
		REMOVE_CUES - remove all cues in interval

    */
    const Method = Object.freeze({
    	LOOKUP_CUES: "lookup-cues",
    	LOOKUP_CUEPOINTS: "lookup-cuepoints",
    	REMOVE_CUES: "remove-cues",
    	INTEGRITY: "integrity"
    });


    /*
		CueOpType
    */

    const CueOpType = Object.freeze({
    	INSERT_CUE: 1,
    	DELETE_CUE: 2,
    	REPLACE_INTERVAL: 3,
    	REPLACE_DATA: 4,
    	REPLACE_CUE: 5,
    });








	/*
		this implements Axis, a datastructure for efficient lookup of cues on a timeline
		- cues may be tied to one or two points on the timeline, this
		is expressed by an Interval.
		- cues are indexed both by key and by cuepoint values
		- cues are maintained in buckets, based on their interval length, for efficient lookup
	*/

	class Axis {


		constructor(equalFunc) {

			// optional equality function for data
			this._equalFunc = equalFunc;

			/*
				efficient lookup of cues by key
				key -> cue
			*/
			this._cueMap = new Map();

			/*
				Initialise set of CueBuckets
				Each CueBucket is responsible for cues of a certain length
			*/
			this._cueBuckets = new Map();  // CueBucketId -> CueBucket
			for (let i=0; i<CueBucketIds.length; i++) {
				let cueBucketId = CueBucketIds[i];
				this._cueBuckets.set(cueBucketId, new CueBucket(cueBucketId));
			}

			// Change event
			eventify.eventifyInstance(this, {init:false});
			this.eventifyDefineEvent("change", {init:false});
		};


		/*
			SIZE
			Number of cues managed by axis
		*/
		get size () {
			return this._cueMap.size;
		}

		/*
			UPDATE
			- insert, replace or delete cues
		*/
		update(cues) {
			// batchMap
			const batchMap = this._makeBatchMap(cues);
	        // cue processing based on batchMap
	        this._processCues(batchMap);
	        // event notification
			this.eventifyTriggerEvent("change", batchMap);
			return batchMap;
		};

		/*
			INTERNAL

			MAKE BATCH MAP (cueMap, cues, equalFunc)

			<cueMap> - map with cues representing state before update
			<equalFunc> - equality function for data objects
			<cues> ordered list of cues to be updated

			cue = {
				key:key,
				interval: Interval,
				data: data
			}

			cue completeness
			required - cue.key property is defined and value is != undefined

			has_data - cue.data property is defined
			has_interval - cue.interval property is Interval object

			pre-existing cues in cueMap

			cueOpType
			INSERT_CUE: no pre-existing cue, cue has both interval and data
			DELETE_CUE: pre-existing cue, no interval and no data
			REPLACE_INTERVAL: pre-existing cue, has interval, but no data
			REPLACE_DATA: pre-existing cue, has data, but no interval
			REPLACE_CUE: pre-existing cue, has both interval and data

			Returns batchMap - describing the effects of an update.

				batchMap is a Map() object
				key -> {new: new_cue, old: old_cue, type: cueOpType}

			- If cue operation applies to cue that already exists, the old cue
			  (before the update) will be included in batchMap,
			  and cueOpType will be relative to old cue.

			- If multiple operations in a batch apply to the same
			cue, items will effectively be collapsed into one operation.

			- If a cue was available before cue processing started,
			this will be reported as old value (if this cue has been modified
			in any way), even if the cue has been modified multiple times
			during the batch. The last cue modification on a given key defines the new
			cue.

			- If a cue is both added and removed in the same batch,
			it will not be included in items.
		*/

	    _makeBatchMap(cues) {

			/*
				batchMap
				key -> {new:new_cue, old:old_cue, type: cueOpType}
			*/
			const batchMap = new Map();
			const len = cues.length;
			let cue, old_cue, latest_cue, new_cue, has_interval, has_data, cueOpType;

			for (let i=0; i<len; i++) {
	    		cue = cues[i];
	    		// check cue
	    		if (!(cue) || !cue.hasOwnProperty("key") || cue.key == undefined) {
	    			throw new Error("illegal cue", cue);
	    		}
	    		has_interval = cue.hasOwnProperty("interval") && cue.interval instanceof Interval
	    		has_data = cue.hasOwnProperty("data");

				/*
					special case on init
				*/
	    		if (this._cueMap.size == 0) {
	    			if (has_interval && has_data) {
	    				batchMap.set(cue.key, {
		    				new:cue, old:undefined, type:CueOpType.INSERT
	    				});
	    			}
	    			continue;
	    		}

	    		// old cue
	    		old_cue = this._cueMap.get(cue.key);
	    		// new cue
	    		new_cue = cue;
	    		// select cue operation
	    		if (old_cue == undefined) {
					/*
						insert new cue
						- requires both interval and data to be defined
					*/
					if (!has_interval || !has_data) {
						// NOOP
						continue;
					} else {
						// INSERT
						cueOpType = CueOpType.INSERT_CUE;
					}
	    		} else {
	    			// replace or delete existing cue
	    			if (!has_interval && !has_data) {
	    				// DELETE
						// delete existing cue
						new_cue = undefined;
						cueOpType = CueOpType.DELETE_CUE;
		    		} else {
		    			// REPLACE
						// - preserve data from latest cue
						// - from batch map or old cue
			    		latest_cue = batchMap.get(cue.key) || old_cue;
						/*
							Equality - if either interval or data
							happens to be equal to the state of the latest cue,
							there is no need to update - NOOP.

							Update has_data and has_interval to reflect this
							equal is the same as not providing
						*/
						if (has_data && this._equalFunc) {
							if (this._equalFunc(cue.data, latest_cue.data)) {
								has_data = false;
							}
						}
						if (has_interval) {
							if (cue.interval.equals(latest_cue.interval)) {
								has_interval = false;
							}
						}
						if (!has_interval && !has_data) {
							// NOOP - due to equality
							continue;
						} else if (!has_data) {
							// REPLACE_INTERVAL
			    			new_cue.data = latest_cue.data;
			    			cueOpType = CueOpType.REPLACE_INTERVAL;
						} else if (!has_interval) {
							// REPLACE_DATA
			    			new_cue.interval = latest_cue.interval;
			    			cueOpType = CueOpType.REPLACE_DATA;
						} else {
							// REPLACE_CUE
							// replace interval and data
							cueOpType = CueOpType.REPLACE_CUE;
						}
		    		}
	    		}

	    		batchMap.set(cue.key, {
	    			new:new_cue, old:old_cue, type:cueOpType
	    		});
			}
			return batchMap;
	    }

		/*
			INTERNAL FUNCTION
			dispatch cue operations from batchMap to appropriate cue bucket
		*/
		_processCues(batchMap) {
			for (let item of batchMap.values()) {
				// update cue buckets
				if (item.old) {
					let cueBucketId = getCueBucketId(item.old.interval.length);
					this._cueBuckets.get(cueBucketId).processCue("remove", item.old);
				}
				if (item.new) {
					let cueBucketId = getCueBucketId(item.new.interval.length);
					let cueBucket = this._cueBuckets.get(cueBucketId);
					cueBucket.processCue("add", item.new);
				}
				// update cueMap
				if (item.new) {
					this._cueMap.set(item.new.key, item.new);
				} else {
					this._cueMap.delete(item.old.key);
				}
			}
			// flush all buckets so updates take effect
			for (let cueBucket of this._cueBuckets.values()) {
				cueBucket.flush();
			}
		};


		/*
			INTERNAL FUNCTION
			execute method across all cue buckets
			and aggregate results
		*/
		_execute(method, interval, semantic) {
			const res = [];
			for (let cueBucket of this._cueBuckets.values()) {
				let cues = cueBucket.execute(method, interval, semantic);
				if (cues.length > 0) {
					res.push(cues);
				}
			}
			return [].concat(...res);
		};

		/*
			GET CUEPOINTS BY INTERVAL

			returns (point, cue) for all points covered by given interval

			returns:
				- list of cuepoints, from cue endpoints within interval
				- [{point: point, cue:cue}]
		*/
		getCuePointsByInterval(interval) {
			return this._execute(Method.LOOKUP_CUEPOINTS, interval);
		};

		/*
			GET CUES BY INTERVAL

			semantic - "inside" | "partial" | "overlap"

		*/
		getCuesByInterval(interval, semantic=Semantic.OVERLAP) {
			return this._execute(Method.LOOKUP_CUES, interval, semantic);
		};


		/*
			REMOVE CUES BY INTERVAL
		*/
		removeCuesByInterval(interval, semantic=Semantic.INSIDE) {
			const cues = this._execute(Method.REMOVE_CUES, interval, semantic);
			// remove from cueMap and make events
			const eventMap = new Map();
			for (let i=0; i<cues.length; i++) {
				let cue = cues[i];
				this._cueMap.delete(cue.key);
				eventMap.set(cue.key, {'old': cue});
			}
			this.eventifyTriggerEvent("change", eventMap);
			return eventMap;
		};

		/*
			CLEAR ALL CUES
		*/
		clear() {
			// clear cue Buckets
			for (let cueBucket of this._cueBuckets.values()) {
				cueBucket.clear();
			}
			// clear cueMap
			let cueMap = this._cueMap;
			this._cueMap = new Map();
			// create change events for all cues
			let e = [];
			for (let cue of cueMap.values()) {
				e.push({'old': cue});
			}
			this.eventifyTriggerEvent("change", e);
			return cueMap;
		};


		/*
			Accessors
		*/

		has(key) {
			return this._cueMap.has(key);
		};

		get(key) {
			return this._cueMap.get(key);
		};

		keys() {
			return [...this._cueMap.keys()];
		};

		cues() {
			return [...this._cueMap.values()];
		};


		/*
			utility
		*/
		_integrity() {
			const res = this._execute(Method.INTEGRITY);

			// sum up cues and points
			let cues = [];
			let points = [];
			for (let bucketInfo of res.values()) {
				cues.push(bucketInfo.cues);
				points.push(bucketInfo.points);
			}
			cues = [].concat(...cues);
			points = [].concat(...points);
			// remove point duplicates if any
			points = [...new Set(points)];

			if (cues.length != this._cueMap.size) {
				throw new Error("inconsistent cue count cueMap and aggregate cueBuckets " + cues-this._cueMap.size);
			}

			// check that cues are the same
			for (let cue of cues.values()) {
				if (!this._cueMap.has(cue.key)) {
					throw new Error("inconsistent cues cueMap and aggregate cueBuckets");
				}
			}

			return {
				cues: cues.length,
				points: points.length
			};
		};

	}


	eventify.eventifyPrototype(Axis.prototype);




	/*
		CueBucket is a bucket of cues limited to specific length
	*/


	class CueBucket {


		constructor(maxLength) {

			// max length of cues in this bucket
			this._maxLength = maxLength;

			/*
				pointMap maintains the associations between values (points on
				the timeline) and cues that reference such points. A single point value may be
				referenced by multiple cues, so one point value maps to a list of cues.

				value -> [cue, ....]
			*/
			this._pointMap = new Map();


			/*
				pointIndex maintains a sorted list of numbers for efficient lookup.
				A large volume of insert and remove operations may be problematic
				with respect to performance, so the implementation seeks to
				do a single bulk update on this structure, for each batch of cue
				operations (i.e. each invocations of addCues). In order to do this
				all cue operations are processed to calculate a single batch
				of deletes and a single batch of inserts which then will be applied to
				the pointIndex in one atomic operation.

				[1.2, 3, 4, 8.1, ....]
			*/
			this._pointIndex = new BinarySearch();

			// bookeeping during batch processing
			this._created = new Set(); // point
			this._dirty = new Set(); // point
		};


		/*

			CUE BATCH PROCESSING

			Needs to translates cue operations into a minimum set of
			operations on the pointIndex.

			To do this, we need to record points that are created and
			points which are modified.

			The total difference that the batch of cue operations
			amounts to is expressed as one list of values to be
			deleted, and and one list of values to be inserted.
			The update operation of the pointIndex will process both
			in one atomic operation.

			On flush both the pointMap and the pointIndex will brought
			up to speed

			created and dirty are used for bookeeping during
			processing of a cue batch. They are needed to
			create the correct diff operation to be applied on pointIndex.

			created : includes values that were not in pointMap
			before current batch was processed

			dirty : includes values that were in pointMap
			before curent batch was processed, and that
			have been become empty at least at one point during cue
			processing.

			created and dirty are used as temporary alternatives to pointMap.
			after the cue processing, pointmap will updated based on the
			contents of these two.

			operation add or remove for given cue

			this method may be invoked at most two times for the same key.
			- first "remove" on the old cue
			- second "add" on the new cue


			"add" means point to be added to point
			"remove" means cue to be removed from point

			process buffers operations for pointMap and index so that
			all operations may be applied in one batch. This happens in flush
		*/

		processCue(op, cue) {

			let points, point, cues;
			if (cue.singular) {
				points = [cue.interval.low]
			} else {
				points = [cue.interval.low, cue.interval.high];
			}

			let init = (this._pointMap.size == 0);

			for (let i=0; i<points.length; i++) {
				point = points[i];
				cues = (init) ? undefined : this._pointMap.get(point);
				if (cues == undefined) {
					cues = [];
					this._pointMap.set(point, cues);
					this._created.add(point);
				}
				if (op == "add") {
					addCueToArray(cues, cue);
				} else {
					let empty = removeCueFromArray(cues, cue);
					if (empty) {
						this._dirty.add(point);
					}
				}
			}
		};

		/*
			Batch processing is completed
			Commit changes to pointIndex and pointMap.

			pointMap
			- update with contents of created

			pointIndex
			- points to delete - dirty and empty
			- points to insert - created and non-empty
		*/
		flush() {
			if (this._created.size == 0 && this._dirty.size == 0) {
				return;
			}

			// update pointIndex
			let to_remove = [];
			let to_insert = [];
			for (let point of this._created.values()) {
				let cues = this._pointMap.get(point);
				if (cues.length > 0) {
					to_insert.push(point);
				} else {
					this._pointMap.delete(point);
				}
			}
			for (let point of this._dirty.values()) {
				let cues = this._pointMap.get(point);
				if (cues.length == 0) {
					to_remove.push(point);
					this._pointMap.delete(point);
				}
			}
			this._pointIndex.update(to_remove, to_insert);
			// cleanup
			this._created.clear();
			this._dirty.clear();
		};



		/*
			_getCuesFromInterval

			internal utility function to find cues from endpoints in interval

			getCuesByInterval will find points in interval in pointIndex and
			find the associated cues from pointMap.

			Cues may be reported more than once
			Any specific order of cues is not defined.

			(at least one cue endpoint will be equal to point)

			Note: This function returns only cues with endpoints covered by the interval.
			It does not return cues that cover the interval (i.e. one endpoint at each
			side of the interval).

			option cuepoint signals to include both the cue and its point
			{point:point, cue:cue}
			if not - a list of cues is returned

			the order is defined by point values (ascending), whether points are included or not.
			each point value is reported once, yet one cue
			may be reference by 1 or 2 points.

			returns list of cues, or list of cuepoints, based on options
		*/
		_lookupCuesFromInterval(interval, options={}) {
			const cuepoint = (options.cuepoint != undefined) ? options.cuepoint : false;
			/*
				search for points in pointIndex using interval
				if search interval is <a,b> endpoints a and b will not be included
				this means that at cue [a,b] will not be picked up - as its enpoints are outside the search interval
				however, this also means that a cue <a,b> will not be picked up - which is not correct - as these endpoints are inside the search interval
				solution is to broaden the search and filter away
			*/
			const broadInterval = new Interval(interval.low, interval.high, true, true);
			const points = this._pointIndex.lookup(broadInterval);
			const res = [];
			const len = points.length;
			const cueSet = new Set();
			for (let i=0; i<len; i++) {
				let point = points[i];
				let cues = this._pointMap.get(point);
				for (let j=0; j<cues.length; j++) {
					let cue = cues[j];

					/*
						avoid duplicate cues
						(not for cuepoints, where cues may be associated with two points)
					*/
					if (!cuepoint) {
						if (cueSet.has(cue.key)) {
							continue;
						} else {
							cueSet.add(cue.key);
						}
					}

					/*
					filter out cues that have both endpoints outside the original search interval
					in other words: keep only cue.intervals which have at
					least one endpoint inside the search interval
					*/
					if (cue.interval.hasEndpointInside(interval)) {
						let item = (cuepoint) ? {point:point, cue:cue} : cue;
						res.push(item);
					}
				}
			}
			return res;
		};

		/*
			Find cues that are overlapping search interval, with one endpoint
			at each side.

			define left and right intervals that cover areas on the timeline to
			the left and right of search interval.
			These intervals are limited by the interval maxLength of cues in this bucket,
			so that:
			 - left interval [interval.high-maxLengt, interval.low]
			 - right interval [interval.high, interval.low+maxlength]

			Only need to search one of them. Preferably the one with the fewest cues.
			However, doing two searches to figure out which is shortest is quite possibly more expensive than choosing the longest,
			so no point really

			Choice - always search left.

			If interval.length > maxLength, then there can be no overlapping intervals in this bucket

			Endpoints must not overlap with endpoints of <interval>
			- if interval.lowInclude, then leftInterval.highInclude must be false,
			  and vice versa.
			- the same consideration applies to interval.highInclude
		*/
		_lookupOutsideCuesFromInterval(interval){
			if (interval.length > this._maxLength) {
				return [];
			}

			const highIncludeOfLeftInterval = !interval.lowInclude;
			const leftInterval = new Interval(interval.high - this._maxLength, interval.low, true, highIncludeOfLeftInterval);

			const lowIncludeOfRightInterval = !interval.highInclude;
			const rightInterval = new Interval(interval.high, interval.low + this._maxLength, lowIncludeOfRightInterval, true);

			//	iterate leftInterval to find cues that have endpoints covered by rightInterval
			return this._lookupCuesFromInterval(leftInterval)
				.filter(function (cue) {
					// fast test
					if (interval.high < cue.interval.low) {
						return true;
					}
					// more expensive test that will pick up cornercase
					// where [a,b] will actually be an outside covering interval for <a,b>
					return rightInterval.coversPoint(cue.interval.high);
				});
		};


		/*
			execute dispatches request to given method.

			CUEPOINTS - look up all (point, cue) tuples in search interval

			INSIDE - look up all cues with both endpoints INSIDE the search interval
			PARTIAL - look up all INSIDE cues, plus cues with one endpoint inside the search interval
			ALL - look up all PARTIAL cues, plus cues with one cue at each side of search interval

		*/
		execute(method, interval, semantic) {
			if (this._pointIndex.length == 0) {
				return [];
			}
			if (method == Method.LOOKUP_CUEPOINTS) {
				return this.lookupCuePoints(interval);
			} else if (method == Method.LOOKUP_CUES) {
				return this.lookupCues(interval, semantic);
			} else if (method == Method.REMOVE_CUES) {
				return this.removeCues(interval, semantic);
			} else if (method == Method.INTEGRITY) {
				return this._integrity();
			} else {
				throw new Error("method or semantic not supported " + method + " " + semantic);
			}
		};


		/*
			LOOKUP CUEPOINTS - look up all (point, cue) tuples in search interval
		*/
		lookupCuePoints(interval) {
			return this._lookupCuesFromInterval(interval, {cuepoint:true});
		};


		/*
			LOOKUP CUES
		*/
		lookupCues(interval, semantic=Semantic.OVERLAP) {
			const partial_cues = this._lookupCuesFromInterval(interval, {cuepoint:false});
			if (semantic == Semantic.PARTIAL) {
				return partial_cues;
			} else if (semantic == Semantic.INSIDE) {
				return partial_cues.filter(function (cue) {
					return interval.coversInterval(cue.interval);
				});
			} else if (semantic == Semantic.OVERLAP) {
				const outside_cues = this._lookupOutsideCuesFromInterval(interval);
				return mergeArrays(partial_cues, outside_cues);
			} else {
				throw new Error("illegal semantic " + semantic);
			}
		}


		/*
			REMOVE CUES
		*/
		removeCues(interval, semantic) {
			/*
				update pointMap
				- remove all cues from pointMap
				- remove empty entries in pointMap
				- record points that became empty, as these need to be deleted in pointIndex
				- separate into two bucketes, inside and outside
			*/
			const cues = this.execute(Method.LOOKUP_CUES, interval, semantic);
			const to_remove = [];
			let cue, point, points;
			for (let i=0; i<cues.length; i++) {
				cue = cues[i];
				// points of cue
				if (cue.interval.singular) {
					points = [cue.interval.low];
				} else {
					points = [cue.interval.low, cue.interval.high];
				}
				for (let j=0; j<points.length; j++) {
					point = points[j];
					// remove cue from pointMap
					// delete pointMap entry only if empty
					let empty = removeCueFromArray(this._pointMap.get(point), cue);
					if (empty) {
						this._pointMap.delete(point);
						to_remove.push(point);
					}
				}
			}

			/*
				update pointIndex

				- remove all points within pointIndex
				- exploit locality, the operation is limited to a segment of the index, so
				  the basic idea is to take out a copy of segment (slice), do modifications, and then reinsert (splice)
				- the segment to modify is limited by [interval.low - maxLength, interval.high + maxLenght] as this will cover
				  both cues inside, partial and overlapping.

				# Possible - optimization
				alternative approach using regular update could be more efficient for very samll batches
				this._pointIndex.update(to_remove, []);
				it could also be comparable for huge loads (250.000 cues)
			*/

			to_remove.sort(function(a,b){return a-b});
			this._pointIndex.removeInSlice(to_remove);

			/*
				alternative solution
				this._pointIndex.update(to_remove, []);
			*/

			return cues;
		};


		/*
			Possible optimization. Implement a removecues method that
			exploits locality by removing an entire slice of pointIndex.
			- this can safely be done for LookupMethod.OVERLAP and PARTIAL.
			- however, for LookupMethod.INSIDE, which is likely the most useful
			  only some of the points in pointIndex shall be removed
			  solution could be to remove entire slice, construct a new slice
			  with those points that should not be deleted, and set it back in.
		*/
		clear() {
			this._pointMap = new Map();
			this._pointIndex = new BinarySearch();
		};


		/*
			Integrity test for cue bucket datastructures
			pointMap and pointIndex
		*/
		_integrity() {

			if (this._pointMap.size !== this._pointIndex.length) {
				throw new Error("unequal number of points " + (this._pointMap.size - this._pointIndex.length));
			}

			// check that the same cues are present in both pointMap and pointIndex
			const missing = new Set();
			for (let point of this._pointIndex.values()) {
				if (!this._pointMap.has(point)){
					missing.add(point);
				}
			}
			if (missing.size > 0) {
				throw new Error("differences in points " + [...missing]);
			}

			// collect all cues
			let cues = [];
			for (let _cues of this._pointMap.values()) {
				for (let cue of _cues.values()) {
					cues.push(cue);
				}
			}
			// remove duplicates
			cues = [...new Map(cues.map(function(cue){
				return [cue.key, cue];
			})).values()];

			// check all cues
			for (let cue of cues.values()) {
				if (cue.interval.length > this._maxLength) {
					throw new Error("cue interval violates maxLength ",  cue);
				}
				let points;
				if (cue.singular) {
					points = [cue.interval.low];
				} else {
					points = [cue.interval.low, cue.interval.high];
				}
				for (let point of points.values()) {
					if (!this._pointIndex.has(point)) {
						throw new Error("point from pointMap cue not found in pointIndex ", point);
					}
				}
			}

			return [{
				maxLength: this._maxLength,
				points: [...this._pointMap.keys()],
				cues: cues
			}];
		};

	}


	// module definition
	return Axis;
});
