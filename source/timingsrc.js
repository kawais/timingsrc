
/*
  Written by Ingar Arntzen, Norut
*/

define (['./timingobject/main', './sequencing/main', './mediasync/mediasync'], 
	function (timingobject, sequencing, mediasync) {
	return {
		
		// Utils
		inherit : timingobject.inherit,

		// Timing Object
		TimingObject : timingobject.TimingObject,

		// Timing Converters
		ConverterBase : timingobject.ConverterBase,
		SkewConverter : timingobject.SkewConverter,
		DelayConverter : timingobject.DelayConverter,
		ScaleConverter : timingobject.ScaleConverter,
		LoopConverter : timingobject.LoopConverter,
		RangeConverter : timingobject.RangeConverter,
		TimeShiftConverter : timingobject.TimeShiftConverter,
		LocalConverter : timingobject.LocalConverter,
		DerivativeConverter : timingobject.DerivativeConverter,
		
		// Sequencing
		Interval : sequencing.Interval,
		Sequencer : sequencing.Sequencer,
		IntervalSequencer : sequencing.IntervalSequencer,
		SetPointCallback : sequencing.SetPointCallback,
		SetIntervalCallback : sequencing.SetIntervalCallback,

		// MediaSync
		MediaSync: mediasync.MediaSync,
    	mediaNeedKick : mediasync.needKick
	};
});
